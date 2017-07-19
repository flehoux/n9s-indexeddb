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

function getObjectStore (mixin, model, mode = 'readonly') {
  const db = mixin[$$db]
  const storeName = mixin.storageNameGetter(model, mixin.dbVersion)
  const tx = db.transaction(storeName, mode)
  return tx.objectStore(storeName)
}

function doStore (mixin, flow) {
  return mixin.prepare().then(() => {
    const objectStore = getObjectStore(mixin, this.constructor, 'readwrite')
    const objectData = Storable.encode(this)
    const request = objectStore.put(objectData)
    return wrapAsPromise(request, 'request').then(function () {
      return flow.continueAsync()
    })
  })
}

function doRemove (mixin, flow) {
  return mixin.prepare().then(() => {
    const objectStore = getObjectStore(mixin, this.constructor, 'readwrite')
    const objectKey = Identifiable.idFor(this)
    const request = objectStore.delete(objectKey)
    return wrapAsPromise(request, 'request').then(function () {
      return flow.continueAsync()
    })
  })
}

function doFindOneUsingId (mixin, flow, id) {
  const objectStore = getObjectStore(mixin, this)
  const request = objectStore.get(id)
  return wrapAsPromise(request, 'request').then(function () {
    let reply = new Protocol.Queryable.Success(request.result)
    return flow.resolveAsync(reply)
  }).catch(function () {
    return flow.continueAsync()
  })
}

function doFindOneUsingIndex (mixin, flow, key, value) {
  const objectStore = getObjectStore(mixin, this)
  const index = objectStore.index(key)
  const request = index.get(value)
  return wrapAsPromise(request, 'request').then(function () {
    let reply = new Protocol.Queryable.Success(request.result)
    return flow.resolveAsync(reply)
  })
}

function doFindOneByWalking (mixin, flow, key, value) {
  const objectStore = getObjectStore(mixin, this)
  const req = objectStore.openCursor()
  return new Promise(function (resolve, reject) {
    req.onsuccess = function (event) {
      const cursor = event.target.result
      if (cursor) {
        let item = cursor.value
        if (item[key] === value) {
          let reply = new Protocol.Queryable.Success(item)
          resolve(flow.resolveAsync(reply))
        } else {
          cursor.continue()
        }
      } else {
        resolve(flow.continueAsync())
      }
    }
    req.onerror = reject
  })
}

function doFindOne (mixin, flow, searchArg) {
  if (searchArg == null) {
    return flow.resolve(null)
  }
  return mixin.prepare().then(() => {
    if (typeof searchArg === 'object') {
      const [key] = Object.keys(searchArg)
      if (Identifiable.idKey(this) === key) {
        searchArg = searchArg[key]
      } else {
        if (Searchable.hasField(this, key)) {
          return doFindOneUsingIndex.call(this, mixin, flow, key, searchArg[key])
        } else {
          return doFindOneByWalking.call(this, mixin, flow, key, searchArg[key])
        }
      }
    }
    if (typeof searchArg === 'string' || typeof searchArg === 'number') {
      return doFindOneUsingId.call(this, mixin, flow, searchArg)
    }
  })
}

function doFindAll (mixin, flow) {
  const objectStore = getObjectStore(mixin, this)
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
        if (results.length === 0) {
          resolve(flow.continueAsync())
        } else {
          let reply = new Protocol.Queryable.Success(results)
          resolve(flow.resolveAsync(reply))
        }
      }
    }
    req.onerror = reject
  })
}

function doFindAllUsingId (mixin, flow, id) {
  const objectStore = getObjectStore(mixin, this)
  const request = objectStore.get(id)
  return wrapAsPromise(request, 'request').then(function (event) {
    let reply = new Protocol.Queryable.Success([request.result])
    return flow.resolveAsync(reply)
  }).catch(function () {
    return flow.continueAsync()
  })
}

function doFindAllUsingIndex (mixin, flow, key, value) {
  const objectStore = getObjectStore(mixin, this)
  const index = objectStore.index(key)
  const request = index.getAll(value)
  return wrapAsPromise(request, 'request').then(function (event) {
    let reply = new Protocol.Queryable.Success(request.result)
    return flow.resolveAsync(reply)
  })
}

function doFindAllByWalking (mixin, flow, key, value) {
  const objectStore = getObjectStore(mixin, this)
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
        if (results.length === 0) {
          resolve(flow.continueAsync())
        } else {
          let reply = new Protocol.Queryable.Success(results)
          resolve(flow.resolveAsync(reply))
        }
      }
    }
    req.onerror = reject
  })
}

function doFindMany (mixin, flow, searchArg) {
  return mixin.prepare().then(() => {
    if (searchArg == null) {
      return doFindAll.call(this, mixin, flow)
    }
    const keys = Object.keys(searchArg)
    if (keys.length > 1) {
      return flow.continue()
    }
    const key = keys.pop()
    if (Identifiable.idKey(this) === key) {
      return doFindAllUsingId.call(this, mixin, flow, searchArg[key])
    } else if (Searchable.hasField(this, key)) {
      return doFindAllUsingIndex.call(this, mixin, flow, key, searchArg[key])
    } else {
      return doFindAllByWalking.call(this, mixin, flow, key, searchArg[key])
    }
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
  .implement(Queryable.store, 1000, doStore)
  .implement(Queryable.remove, 1000, doRemove)
  .implement(Queryable.findOne, 1000, doFindOne)
  .implement(Queryable.findMany, 1000, doFindMany)

IndexedDBMixin.prototype.storageNameGetter = function (model, version) {
  let name
  if (model.hasValue(Storable.storageName)) {
    name = Storable.storageName(model)
  } else {
    name = model.name
  }
  return [name, version].join('.')
}

IndexedDBMixin.prototype.prepare = function () {
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
}

IndexedDBMixin.prototype.prepareStoreForModel = function (event, model) {
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
        let newData = Storable.call(model, 'migrateObject', cursor.value, context)
        if (newData != null) {
          newObjectStore.add(newData)
        }
        cursor.continue()
      }
    }
  }

  return wrapAsPromise(newObjectStore.transaction, 'transaction')
}

Object.defineProperty(IndexedDBMixin.prototype, 'db', {
  get: function () {
    return this[$$db]
  }
})

module.exports = IndexedDBMixin
