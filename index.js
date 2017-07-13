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

const IndexedDBMixin = Mixin('IndexedDBMixin')
  .requires(Identifiable)
  .implement(Queryable.store, function (mixin, flow, object) {

  })
  .implement(Queryable.remove, function (mixin, flow, object) {

  })
  .implement(Queryable.findOne, function (mixin, flow, object) {

  })
  .implement(Queryable.findMany, function (mixin, flow, object) {

  })
  .construct(function (options = {}) {
    const {
      db = 'Nucleotides',
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

IndexedDBMixin.prototype.storageNameGetter = function (model, version) {
  let name
  if (Storable.hasValueFor(model, 'storageName')) {
    name = Storable.valueFor(model, 'storageName')
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
          promises.push(this.prepareForModel(event, model))
        }
      }
    }).then((event) => {
      this[$$db] = event.target.result
      return event
    })
  }
}

IndexedDBMixin.prototype.prepareStoreForModel = function (event, model) {
  let idKey = Identifiable.idKeyFor(model)
  let storeName = this.storageNameGetter(model, event.newVersion)
  let searchableFields = Searchable.valueFor(model, 'field')
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

  if (event.oldVersion && Storable.hasImplementationsFor(model, 'migrateObject')) {
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

module.exports = IndexedDBMixin
