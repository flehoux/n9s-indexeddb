/* global describe it expect jasmine */

describe('A Model stored used the IndexedDB mixin', function () {
  const {Model, Protocol} = require('nucleotides')
  const IndexedDBMixin = require('..')

  const idbMixin = new IndexedDBMixin({
    db: 'test',
    version: 5
  })

  let i = 0
  const getID = () => (++i).toString()

  const Person = Model('Person')
    .attributes({
      firstName: String,
      lastName: {
        type: String,
        searchable: true
      },
      nas: String
    })
    .set(Protocol.Identifiable.idKey, 'nas')
    .use(idbMixin)

  it('should be able to create the IndexedDB storage at preparation time', function (done) {
    idbMixin.prepare().then(function () {
      expect(idbMixin.db).not.toBeUndefined()
      expect(Array.from(idbMixin.db.objectStoreNames)).toEqual(['Person.5'])
      let objectStore = idbMixin.db.transaction('Person.5', 'readonly').objectStore('Person.5')
      expect(objectStore.keyPath).toEqual('nas')
      idbMixin.db
        .transaction('Person.5', 'readwrite').objectStore('Person.5')
        .clear()
      done()
    })
  })

  it('should be able to have .prepare() called multiple times', function (done) {
    idbMixin.prepare().then(function () {
      let db = idbMixin.db
      expect(idbMixin.db).not.toBeUndefined()
      expect(Array.from(idbMixin.db.objectStoreNames)).toEqual(['Person.5'])
      idbMixin.prepare().then(function () {
        expect(idbMixin.db).toEqual(db)
        done()
      })
    })
  })

  it('should be able to create an instance and save it to the IndexedDB storage', function (done) {
    idbMixin.prepare().then(function () {
      let id = getID()
      Person.create({nas: id, firstName: 'John', lastName: 'Smith'}).then(function (person) {
        let tx = idbMixin.db.transaction('Person.5')
        let req = tx.objectStore('Person.5').count()
        req.onsuccess = function () {
          expect(req.result).toBe(1)
          req = tx.objectStore('Person.5').get(id)
          req.onsuccess = function () {
            expect(req.result).toEqual(person.$clean)
            done()
          }
        }
      })
    })
  })

  it('should be able to save updates of an instance to the IndexedDB storage', function (done) {
    let id = getID()
    idbMixin.prepare().then(function () {
      Person.create({nas: id, firstName: 'John', lastName: 'Smith'}).then(function () {
        Person.findOne(id).then(function (personFound) {
          personFound.$updateAttributes({ firstName: 'Larry', lastName: 'Stone' }).$save().then(function () {
            Person.findOne(id).then(function (personFound) {
              expect(personFound.$clean).toEqual({
                firstName: 'Larry',
                lastName: 'Stone',
                nas: id
              })
              done()
            })
          })
        })
      })
    })
  })

  it('should be able to retrieve an instance from the IndexedDB storage', function (done) {
    let id = getID()
    idbMixin.prepare().then(function () {
      Person.create({nas: id, firstName: 'Larry', lastName: 'Smith'}).then(function (person) {
        Person.findOne(id).then(function (personFound) {
          expect(personFound.$clean).toEqual(person.$clean)
          expect(person).toEqual(jasmine.any(Person))
          done()
        })
      })
    })
  })

  it('should be able to retrieve multiple instances from the IndexedDB storage using indexed attributes', function (done) {
    let [id1, id2, id3] = [getID(), getID(), getID()]
    idbMixin.prepare().then(function () {
      Promise.all([
        Person.create({nas: id1, firstName: 'John', lastName: 'McCormick'}),
        Person.create({nas: id2, firstName: 'Larry', lastName: 'McCormick'}),
        Person.create({nas: id3, firstName: 'Math', lastName: 'McCormick'})
      ])
      .then(function (person) {
        Person.findMany({lastName: 'McCormick'}).then(function (peopleFound) {
          expect(peopleFound.length).toEqual(3)
          expect(peopleFound[0]).toEqual(jasmine.any(Person))
          expect(peopleFound[1]).toEqual(jasmine.any(Person))
          expect(peopleFound[2]).toEqual(jasmine.any(Person))
          expect(peopleFound.$clean).toEqual([
            {nas: id1, firstName: 'John', lastName: 'McCormick'},
            {nas: id2, firstName: 'Larry', lastName: 'McCormick'},
            {nas: id3, firstName: 'Math', lastName: 'McCormick'}
          ])
          done()
        })
      })
    })
  })

  it('should be able to retrieve multiple instances from the IndexedDB storage using non-indexed attributes', function (done) {
    let [id1, id2] = [getID(), getID()]
    idbMixin.prepare().then(function () {
      Promise.all([
        Person.create({nas: id1, firstName: 'Mary', lastName: 'McCormick'}),
        Person.create({nas: id2, firstName: 'Mary', lastName: 'Smith'})
      ])
      .then(function (person) {
        Person.findMany({firstName: 'Mary'}).then(function (peopleFound) {
          expect(peopleFound.length).toEqual(2)
          expect(peopleFound[0]).toEqual(jasmine.any(Person))
          expect(peopleFound[1]).toEqual(jasmine.any(Person))
          expect(peopleFound.$clean).toEqual([
            {nas: id1, firstName: 'Mary', lastName: 'McCormick'},
            {nas: id2, firstName: 'Mary', lastName: 'Smith'}
          ])
          done()
        })
      })
    })
  })

  it('should be able to remove an instance from the IndexedDB storage', function (done) {
    let id = getID()
    idbMixin.prepare().then(function () {
      Person.create({nas: id, firstName: 'Larry', lastName: 'Smith'}).then(function (person) {
        Person.findOne(id).then(function (personFound) {
          expect(personFound.$clean).toEqual(person.$clean)
          expect(person).toEqual(jasmine.any(Person))
          person.$remove().then(function () {
            Person.findOne(id).then(function (personFound) {
              expect(personFound).toBeUndefined()
              done()
            })
          })
        })
      })
    })
  })
})
