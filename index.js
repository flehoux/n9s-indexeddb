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
  const objectStore = getObjectStore(mixin, this.constructor, 'readwrite')
  const objectData = Storable.encode(this)
  const request = objectStore.put(objectData)
  return wrapAsPromise(request, 'request').then(function () {
    return flow.continueAsync()
  })
}

function doRemove (mixin, flow) {
  const objectStore = getObjectStore(mixin, this.constructor, 'readwrite')
  const objectKey = Identifiable.idFor(this)
  const request = objectStore.delete(objectKey)
  return wrapAsPromise(request, 'request').then(function () {
    return flow.continueAsync()
  })
}

function doFindOne (mixin, flow, searchArg) {
  if (searchArg == null) {
    return flow.resolve(null)
  }
  if (typeof searchArg === 'object') {
    const [key] = Object.keys(searchArg)
    if (Identifiable.idKey(this) === key) {
      searchArg = searchArg[key]
    } else {
      if (Searchable.hasField(this, key)) {
        const objectStore = getObjectStore(mixin, this)
        const index = objectStore.index(key)
        const request = index.get(searchArg[key])
        return wrapAsPromise(request, 'request').then(function () {
          let reply = new Protocol.Queryable.Success(request.result)
          return flow.resolveAsync(reply)
        })
      } else {
        const objectStore = getObjectStore(mixin, this)
        const req = objectStore.openCursor()
        return new Promise(function (resolve, reject) {
          req.onsuccess = function (event) {
            const cursor = event.target.result
            if (cursor) {
              let item = cursor.value
              if (item[key] === searchArg[key]) {
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
    }
  }
  if (typeof searchArg === 'string' || typeof searchArg === 'number') {
    const objectStore = getObjectStore(mixin, this)
    const request = objectStore.get(searchArg)
    return wrapAsPromise(request, 'request').then(function () {
      let reply = new Protocol.Queryable.Success(request.result)
      return flow.resolveAsync(reply)
    }).catch(function () {
      return flow.continueAsync()
    })
  }
}

function doFindMany (mixin, flow, searchArg) {
  if (searchArg == null) {
    return flow.resolve(null)
  }
  const keys = Object.keys(searchArg)
  if (keys.length > 1) {
    return flow.continue()
  }
  const key = keys.pop()
  if (Identifiable.idKey(this) === key) {
    const objectStore = getObjectStore(mixin, this)
    const request = objectStore.get(searchArg)
    return wrapAsPromise(request, 'request').then(function (event) {
      let reply = new Protocol.Queryable.Success([request.result])
      return flow.resolveAsync(reply)
    }).catch(function () {
      return flow.continueAsync()
    })
  } else if (Searchable.hasField(this, key)) {
    const objectStore = getObjectStore(mixin, this)
    const index = objectStore.index(key)
    const request = index.getAll(searchArg[key])
    return wrapAsPromise(request, 'request').then(function (event) {
      let reply = new Protocol.Queryable.Success(request.result)
      return flow.resolveAsync(reply)
    })
  } else {
    const objectStore = getObjectStore(mixin, this)
    const req = objectStore.openCursor()
    let results = []
    return new Promise(function (resolve, reject) {
      req.onsuccess = function (event) {
        const cursor = event.target.result
        if (cursor) {
          let item = cursor.value
          if (item[key] === searchArg[key]) {
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
  .implement(Queryable.store, doStore)
  .implement(Queryable.remove, doRemove)
  .implement(Queryable.findOne, doFindOne)
  .implement(Queryable.findMany, doFindMany)

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
