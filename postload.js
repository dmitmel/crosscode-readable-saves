if (ig.platform !== ig.PLATFORM_TYPES.DESKTOP) {
  throw new Error('only desktop is supported');
}

ig.module('readable-saves')
  .requires('impact.feature.storage.storage')
  .defines(() => {
    const fs = require('fs').promises;
    const path = require('path');

    function serializePretty(data) {
      return JSON.stringify(data, null, 2);
    }

    async function readJsonFile(file) {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    }

    async function readJsonFileOptional(file) {
      try {
        return await readJsonFile(file);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        return null;
      }
    }

    async function mkdirIfNotExists(dir, options) {
      try {
        await fs.mkdir(dir, options);
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }

    function countDigits(n) {
      n = Math.abs(n);
      let result = 1;
      while (n >= 10) {
        n /= 10;
        result++;
      }
      return result;
    }

    // TODO: explain why I don't use backups

    ig.StorageDataReadable = ig.Class.extend({
      loaded: false,
      cacheType: 'StorageDataReadable',
      path: 'cc-readable-save',
      loadedData: null,

      saveInProgress: false,
      queuedSaveData: null,

      init() {
        ig.addResource(this);
      },

      async load(loadCallback) {
        try {
          for (let gameDataDir of this.constructor.GAME_DATA_DIRECTORIES) {
            let rootDir = path.join(gameDataDir, this.path);
            let loadedData = await this._readFromDir(rootDir);
            // `null` returned by `_readFromDir` basically means "the error
            // (e.g. a missing directory) is not a big deal, let's try to load
            // from the next location"
            if (loadedData != null) {
              this.loadedData = loadedData;
              break;
            }
          }
        } catch (err) {
          err.message = `An error occured while loading the savegame. (note: You still can recover it from the default save file format)\n${err.message}`;
          ig.system.error(err);
          throw err;
          // Note that `loadCallback` is implicitly not called here (due to an
          // exception thrown either by `ig.system.error` or a literal `throw err`
          // here) for two reasons. Firstly, for whatever reason the game
          // continues to load even in the broken state when some of the
          // resources have failed loading. Secondly, the popup shown by
          // `ig.system.error` inside `loadCallback` overlaps ours.
        }

        loadCallback(this.cacheType, this.path, true);
      },

      async _readFromDir(rootDir) {
        let globals;

        // `globals.json` is used here to test the existance of the save
        // directory precisely because regular save files are guranteed to
        // contain globals data, so this file will always be present in correct
        // readable save dirs as well
        try {
          globals = await readJsonFile(path.join(rootDir, 'globals.json'));
        } catch (err) {
          if (err.code === 'ENOENT') {
            try {
              await fs.stat(rootDir);
            } catch (err2) {
              if (err2.code === 'ENOENT') {
                // the save dir doesn't exist? not a big deal, let's try another one
                return null;
              }
              // What? So now we can't even `stat` the root directory? Let's
              // just show the original error which caused this check, perhaps
              // it will be more informative to the user.
            }
          }

          throw err;
        }

        // don't know if checks for existance of the save dir are needed here
        // after a successful attempt to read `globals.json`, in other words
        // special-case checks on ENOENT errors

        let slotsDir = path.join(rootDir, 'slots');
        let slotsDirFilenames = (
          await fs.readdir(slotsDir, { withFileTypes: true })
        )
          .filter((dirent) => !dirent.isDirectory())
          .map((dirent) => dirent.name)
          .sort();

        // files are read in parallel for MAXIMUM PERFORMANCE BOOST
        let [slots, autoSlot, misc] = await Promise.all([
          Promise.all(
            slotsDirFilenames.map((filename) =>
              readJsonFile(path.join(slotsDir, filename)),
            ),
          ),
          readJsonFileOptional(path.join(rootDir, 'autoSlot.json')),
          readJsonFileOptional(path.join(rootDir, 'misc.json')),
        ]);

        return { slots, autoSlot, globals, lastSlot: misc.lastSlot };
      },

      save(data) {
        if (!this.saveInProgress) this._write(data);
        else this.queuedSaveData = data;
      },

      async _write(data) {
        this.saveInProgress = true;

        try {
          let rootDir = path.join(
            this.constructor.GAME_DATA_DIRECTORIES[0],
            this.path,
          );
          this._writeToDir(rootDir, data);
        } catch (err) {
          // note that here I don't crash the game with `ig.system.error`
          // because the user might still have the chance of repairing their
          // filesystem and making their savefile writable, with `chmod` or
          // `chown` for example
          err.message = `An error occured while writing the savegame. Please repair your filesystem immediately!!!\n${err.message}`;
          console.error(err);
        } finally {
          this._onWriteFinished();
        }
      },

      async _writeToDir(rootDir, data) {
        // TODO: explain file modes

        // first of all, create the directory structure in the correct order
        await mkdirIfNotExists(rootDir);
        let slotsDir = path.join(rootDir, 'slots');
        await mkdirIfNotExists(slotsDir);

        let slotFileDigits = Math.max(2, countDigits(data.slots.length));

        // `_readFromDir` reads all of the files in the slots directory, so
        // we need to cleanup the useless junk, e.g. deleted save slots. Also,
        // if we don't perform the cleanup and the user drops there a new file
        // which isn't explicitly overwritten here (for example because of
        // having a non-numeric filename), it will be added to the slots list
        // every time the savegame is read, therefore creating an infinitely
        // growing slot list.
        let slotsDirFilenamesToDelete = new Set();
        for (let dirent of await fs.readdir(slotsDir, {
          withFileTypes: true,
        })) {
          if (dirent.isDirectory()) continue;

          if (slotsDirFilenamesToDelete.has(dirent.name)) {
            // what the hell???
            throw new Error(
              `duplicate filename ${dirent.name} in directory ${slotsDir}`,
            );
          }
          slotsDirFilenamesToDelete.add(dirent.name);
        }

        let promises = data.slots.map((slotData, index) => {
          let indexStr = index.toString(10).padStart(slotFileDigits, '0');
          let filename = `${indexStr}.json`;
          slotsDirFilenamesToDelete.delete(filename);
          return fs.writeFile(path.join(slotsDir, filename), slotData, 'utf8');
        });

        for (let filename of slotsDirFilenamesToDelete) {
          promises.push(fs.unlink(path.join(slotsDir, filename)));
        }

        promises.push(
          fs.writeFile(
            path.join(rootDir, 'autoSlot.json'),
            data.autoSlot,
            'utf8',
          ),
          fs.writeFile(
            path.join(rootDir, 'globals.json'),
            data.globals,
            'utf8',
          ),
          fs.writeFile(path.join(rootDir, 'misc.json'), data.misc, 'utf8'),
        );

        // now that all directories have been created, I can fire up all actual
        // file writes in parallel (once again) FOR MASSIVE PERFORMANCE BOOST
        await Promise.all(promises);
      },

      _onWriteFinished() {
        if (this.queuedSaveData != null) {
          let data = this.queuedSaveData;
          this.queuedSaveData = null;
          this._write(data);
        } else {
          this.saveInProgress = false;
        }
      },
    });

    {
      let pathList = [];

      // On Windows `nw.App.dataPath` is `%LOCALAPPDATA%\CrossCode\User Data\Default`,
      // yet the game writes the savegame to `%LOCALAPPDATA%\CrossCode` when
      // possible, so I reproduce this behavior. Notice that this implementation
      // IS BROKEN when %LOCALAPPDATA% contains the `\User Data\Default`
      // substring, but eh, whatever, this is the exact piece of code the stock
      // game uses.
      let { dataPath } = nw.App;
      let userDataIndex = dataPath.indexOf('\\User Data\\Default');
      if (userDataIndex >= 0) pathList.push(dataPath.slice(0, userDataIndex));
      pathList.push(dataPath);

      ig.StorageDataReadable.GAME_DATA_DIRECTORIES = pathList;
    }

    ig.Storage.inject({
      readableData: new ig.StorageDataReadable(),

      init(...args) {
        if (this.readableData.loadedData != null) {
          this.data.data = this.readableData.loadedData;
        }
        this.parent(...args);
        // free up a bit of memory
        this.readableData.loadedData = null;
        this.data.data = null;
      },

      _saveToStorage() {
        let globals = {};
        for (let listener of this.listeners) {
          if (listener.onStorageGlobalSave != null) {
            listener.onStorageGlobalSave(globals);
          }
        }

        let savesData = {
          slots: this.slots.map((slot) => slot.data),
          autoSlot: this.autoSlot != null ? this.autoSlot.data : null,
          globals,
          lastSlot: this.lastUsedSlot,
        };
        // TODO: explain that replacing the original save format is perfectly
        // backward-compatible
        this.data.save(JSON.stringify(savesData));

        // TODO: consider using https://github.com/ibmruntimes/yieldable-json
        // for faster serialization
        this.readableData.save({
          slots: savesData.slots.map((slot) => serializePretty(slot)),
          autoSlot: serializePretty(savesData.autoSlot),
          globals: serializePretty(savesData.globals),
          misc: serializePretty({ lastSlot: savesData.lastSlot }),
        });

        return savesData;
      },
    });
  });
