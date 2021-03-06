'use strict'

const $$db = Symbol('db')

const {Mixin, Protocol} = require('nucleotides')
const {Identifiable, Searchable, Queryable, Storable} = Protocol

function wrapAsPromise (target, type, hooks = {}) {
  let resolver
  let rejector
  let resolved
  let rejected
  let prop
  if (type === 'request') {
    prop = 'onsuccess'
  } else if (type === 'transaction') {
    prop = 'oncomplete'
  }
  target[prop] = function (event) {
    if (resolver != null) {
      resolver(event)
    } else {
      resolved = event
    }
  }
  target.onerror = function (error) {
    if (rejector != null) {
      rejector(error)
    } else {
      rejected = error
    }
  }
  for (let hookName in hooks) {
    target['on' + hookName] = hooks[hookName]
  }
  return new Promise(function (resolve, reject) {
    if (resolved != null) {
      resolve(...resolved)
    } else if (rejected != null) {
      reject(rejected)
    } else {
      resolver = resolve
      rejector = reject
    }
  })
}

function resolveAsync (value) {
  return new Promise(function (resolve) {
    setTimeout(function () { resolve(value) })
  })
}

const IndexedDBMixin = Mixin('IndexedDBMixin')
  .construct(function (options = {}) {
    const {
      db = 'N9S',
      version = 1,
      storeName,
      migrate
    } = options
    this.dbName = db
    this.dbVersion = version
    if (storeName != null) {
      this.storageNameGetter = storeName
    }
    if (migrate != null) {
      this.migrate = migrate
    }
  })
  .require(Identifiable)
  .implement(Queryable.store, 1000, function doStore (mixin, flow) {
    const {Model} = require('nucleotides')
    return flow.continue().then((response) => {
      if (!(response instanceof Protocol.Queryable.Success)) {
        response = new Protocol.Queryable.Success(this, 200)
      }
      let objectData
      if (typeof response.data !== 'object' || response.data == null || response.data[Identifiable.idKey(this.constructor)] == null) {
        if (Model.isInstance(response.result)) {
          objectData = Storable.encode(response.result)
        } else {
          objectData = Storable.encode(this)
        }
      } else {
        objectData = response.data
      }
      return mixin.addObject(this.constructor, objectData).then(function () {
        return flow.resolveAsync(response)
      })
    })
  })
  .implement(Queryable.remove, 1000, function (mixin, flow) {
    return flow.continue().then((response) => {
      if (!(response instanceof Protocol.Queryable.Success)) {
        response = new Protocol.Queryable.Success(true)
      }
      return mixin.removeObject(this).then(() => {
        flow.resolveAsync(response)
      })
    })
  })
  .implement(Queryable.findOne, 1000, function (mixin, flow, searchArg) {
    if (searchArg == null) {
      return flow.resolve(null)
    } else {
      return mixin.getObject(this, searchArg).then((result) => {
        if (result == null) {
          return flow.continueAsync()
        } else {
          return flow.resolveAsync(new Protocol.Queryable.Success(result))
        }
      }).catch(function () {
        return flow.continueAsync()
      })
    }
  })
  .implement(Queryable.findMany, 1000, function (mixin, flow, searchArg) {
    if (searchArg != null && Object.keys(searchArg).length > 1) {
      return flow.continue()
    } else {
      return mixin.findObjects(this, searchArg).then((results) => {
        if (results.length === 0) {
          return flow.continueAsync()
        }
        let reply = new Protocol.Queryable.Success(results)
        return flow.resolveAsync(reply)
      }).catch(function () {
        return flow.continueAsync()
      })
    }
  })

Object.defineProperty(IndexedDBMixin.prototype, 'db', {
  get: function () { return this[$$db] }
})

Object.assign(IndexedDBMixin.prototype, {
  storageNameGetter: function (model, version) {
    let name
    if (model.hasValue(Storable.storageName)) {
      name = Storable.storageName(model)
    } else {
      name = model.name
    }
    return [name, version].join('.')
  },
  prepare: function () {
    if (this[$$db] != null) {
      return Promise.resolve(this[$$db])
    } else {
      let req = window.indexedDB.open(this.dbName, this.dbVersion)
      return wrapAsPromise(req, 'request', {
        upgradeneeded: (event) => {
          let promises = []
          for (let model of this.models) {
            promises.push(this.prepareStoreForModel(event, model))
          }
        }
      }).then((event) => {
        this[$$db] = event.target.result
        return event
      })
    }
  },
  prepareStoreForModel: function (event, model) {
    let idKey = Identifiable.idKey(model)
    let storeName = this.storageNameGetter(model, event.newVersion)
    let searchableFields = Searchable.valueFor(model, 'field') || []
    let db = event.target.result
    let newObjectStore = db.createObjectStore(storeName, { keyPath: idKey })

    for (let field of searchableFields) {
      if (typeof field === 'string') {
        field = {key: field, unique: false}
      }
      let attribute = model.attribute(field.key)
      newObjectStore.createIndex(field.key, field.key, {
        unique: field.unique === true,
        multiEntry: attribute.collection
      })
    }

    if (event.oldVersion && model.implements(Storable.migrateObject)) {
      let oldStoreName = this.storageNameGetter(model, event.oldVersion)
      let transaction = db.transaction(oldStoreName, 'readonly')
      let objectStore = transaction.objectStore(oldStoreName)
      let context = {oldVersion: event.oldVersion, newVersion: event.newVersion}
      objectStore.openCursor().onsuccess = function (event) {
        let cursor = event.target.result
        if (cursor) {
          let newData = Storable.migrateObject(model, cursor.value, context)
          if (newData != null) {
            newObjectStore.add(newData)
          }
          cursor.continue()
        }
      }
    }

    return wrapAsPromise(newObjectStore.transaction, 'transaction')
  },
  getStore: function (model, mode = 'readonly') {
    const db = this[$$db]
    const storeName = this.storageNameGetter(model, this.dbVersion)
    const tx = db.transaction(storeName, mode)
    return tx.objectStore(storeName)
  },

  findObjects: function (model, searchArg) {
    return this.prepare().then(() => {
      if (searchArg == null) {
        return this.getAllObjects(model)
      }
      const keys = Object.keys(searchArg)
      const key = keys.pop()
      if (Identifiable.idKey(model) === key) {
        return this.findObjectsUsingId(model, searchArg[key])
      } else if (Searchable.hasField(model, key)) {
        return this.findObjectsUsingIndex(model, key, searchArg[key])
      } else {
        return this.findObjectsByWalking(model, key, searchArg[key])
      }
    })
  },
  findObjectsByWalking: function (model, key, value) {
    const objectStore = this.getStore(model)
    const req = objectStore.openCursor()
    let results = []
    return new Promise(function (resolve, reject) {
      req.onsuccess = function (event) {
        const cursor = event.target.result
        if (cursor) {
          let item = cursor.value
          if (item[key] === value) {
            results.push(item)
          }
          cursor.continue()
        } else {
          setTimeout(function () { resolve(results) })
        }
      }
      req.onerror = reject
    })
  },
  findObjectsUsingIndex: function (model, key, value) {
    const objectStore = this.getStore(model)
    const index = objectStore.index(key)
    const request = index.getAll(value)
    return wrapAsPromise(request, 'request').then(function (event) {
      return resolveAsync(request.result)
    })
  },
  findObjectsUsingId: function (model, id) {
    const objectStore = this.getStore(model)
    const request = objectStore.get(id)
    return wrapAsPromise(request, 'request').then(function (event) {
      return resolveAsync([request.result])
    })
  },
  getAllObjects: function (model) {
    const objectStore = this.getStore(model)
    const req = objectStore.openCursor()
    let results = []
    return new Promise(function (resolve, reject) {
      req.onsuccess = function (event) {
        const cursor = event.target.result
        if (cursor) {
          let item = cursor.value
          results.push(item)
          cursor.continue()
        } else {
          setTimeout(function () { resolve(results) })
        }
      }
      req.onerror = reject
    })
  },

  getObject: function (model, searchArg) {
    return this.prepare().then(() => {
      if (typeof searchArg === 'object') {
        const [key] = Object.keys(searchArg)
        if (Identifiable.idKey(model) === key) {
          searchArg = searchArg[key]
        } else {
          if (Searchable.hasField(model, key)) {
            return this.getObjectUsingIndex(model, key, searchArg[key])
          } else {
            return this.getObjectByWalking(model, key, searchArg[key])
          }
        }
      }
      if (typeof searchArg === 'string' || typeof searchArg === 'number') {
        return this.getObjectUsingId(model, searchArg)
      }
    })
  },
  getObjectUsingId: function (model, id) {
    const objectStore = this.getStore(model)
    const request = objectStore.get(id)
    return wrapAsPromise(request, 'request').then(function () {
      return resolveAsync(request.result)
    })
  },
  getObjectUsingIndex: function (model, key, value) {
    const objectStore = this.getStore(model)
    const index = objectStore.index(key)
    const request = index.get(value)
    return wrapAsPromise(request, 'request').then(function () {
      return resolveAsync(request.result)
    })
  },
  getObjectByWalking: function (model, key, value) {
    const objectStore = this.getStore(model)
    const req = objectStore.openCursor()
    return new Promise(function (resolve, reject) {
      req.onsuccess = function (event) {
        const cursor = event.target.result
        if (cursor) {
          let item = cursor.value
          if (item[key] === value) {
            setTimeout(function () { resolve(item) })
          } else {
            cursor.continue()
          }
        } else {
          setTimeout(function () { resolve(null) })
        }
      }
      req.onerror = reject
    })
  },

  removeObject: function (object, id) {
    const {Model} = require('nucleotides')
    return this.prepare().then(() => {
      let objectStore
      let objectKey
      if (Model.isInstance(object)) {
        objectStore = this.getStore(object.constructor, 'readwrite')
        objectKey = Identifiable.idFor(object)
      } else if (Model.isModel(object) && typeof id === 'string') {
        objectStore = this.getStore(object, 'readwrite')
        objectKey = id
      } else {
        throw new Error(`IndexedDBMixin.removeObject was called in a unsupported manner. object: ${object}, id: ${id}`)
      }
      return wrapAsPromise(objectStore.delete(objectKey), 'request')
    })
  },
  clearObjects: function (model) {
    return this.prepare().then(() => {
      let objectStore = this.getStore(model, 'readwrite')
      return wrapAsPromise(objectStore.clear(), 'request')
    })
  },
  addObject: function (object, data) {
    const {Model} = require('nucleotides')
    return this.prepare().then(() => {
      let objectStore
      let objectData
      if (Model.isInstance(object)) {
        objectStore = this.getStore(object.constructor, 'readwrite')
        objectData = Storable.encode(object)
      } else if (Model.isModel(object) && data != null && typeof data === 'object') {
        objectStore = this.getStore(object, 'readwrite')
        objectData = data
      }
      return wrapAsPromise(objectStore.put(objectData), 'request')
    })
  },
  addObjects: function (model, items) {
    const {Model} = require('nucleotides')
    return this.prepare().then(() => {
      let objectStore
      objectStore = this.getStore(model, 'readwrite')
      let promises = items.map((item) => {
        let data
        if (Model.isInstance(item)) {
          data = Storable.encode(item)
        } else {
          data = item
        }
        return wrapAsPromise(objectStore.put(data), 'request')
      })
      return Promise.all(promises)
    })
  }
})

module.exports = IndexedDBMixin
