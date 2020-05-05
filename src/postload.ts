import './platform-check.js';
import fs from './node-builtin-modules/fs.js';
import path from './node-builtin-modules/path.js';

const fsp = fs.promises;

ig.module('readable-saves')
  .requires('impact.feature.storage.storage')
  .defines(() => {
    function stringifyPretty(data: unknown): string {
      return JSON.stringify(data, null, 2);
    }

    async function readJsonFile<T>(file: string): Promise<T> {
      let text = await fsp.readFile(file, 'utf8');
      try {
        return JSON.parse(text);
      } catch (err) {
        err.message = `JSON syntax error in file '${file}':\n${err.message}`;
        throw err;
      }
    }

    async function readJsonFileOptional<T>(file: string): Promise<T | null> {
      try {
        return await readJsonFile(file);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        return null;
      }
    }

    async function mkdirIfNotExists(dir: string): Promise<void> {
      try {
        await fsp.mkdir(dir);
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }

    function countDigits(n: number): number {
      n = Math.abs(n);
      let result = 1;
      while (n >= 10) {
        n /= 10;
        result++;
      }
      return result;
    }

    ig.SaveSlot.inject({
      stringified: null,
      stringifiedPretty: null,

      init(srcOrData) {
        if (ig.StorageTools.isEncrypted(srcOrData)) {
          this.data = ig.StorageTools.decryptSlotData(srcOrData);
        } else {
          // Note that I skip re-encryption here. Firstly, That's because I
          // don't use the unencrypted text anyway (see the implementation of
          // `ig.Storage#_saveToStorage`). Secondly, AES encryption used in
          // `ig.StorageTools` (and cryptography in general) is SLOW, it takes
          // ~80 ms per save on my machine.
          this.data = srcOrData;
        }

        // these two lines usually take about 10 ms, much faster than AES as you
        // can probably guess
        this.stringified = JSON.stringify(this.data);
        this.stringifiedPretty = stringifyPretty(this.data);
      },

      getSrc() {
        throw new Error('crosscode-readable-saves: saves are unencrypted!!!');
      },
    });

    ig.StorageDataReadable = ig.Class.extend({
      loaded: false,
      cacheType: 'StorageDataReadable',
      path: 'cc-readable-save',
      loadedData: null,

      saveInProgress: false,
      queuedSaveData: null,

      init() {
        ig.ready ? this.load() : ig.addResource(this);
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

        if (loadCallback != null) loadCallback(this.cacheType, this.path, true);
      },

      async _readFromDir(rootDir): Promise<ig.StorageData.SaveFileData | null> {
        let globals: ig.Storage.GlobalsData;

        // `globals.json` is used here to test the existance of the save
        // directory precisely because regular save files are guranteed to
        // contain globals data, so this file will always be present in correct
        // readable save dirs as well
        try {
          globals = await readJsonFile(path.join(rootDir, 'globals.json'));
        } catch (err) {
          if (err.code === 'ENOENT') {
            try {
              await fsp.stat(rootDir);
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
          await fsp.readdir(slotsDir, { withFileTypes: true })
        )
          .filter((dirent) => !dirent.isDirectory())
          .map((dirent) => dirent.name)
          .sort();

        // files are read in parallel for MAXIMUM PERFORMANCE BOOST
        let [slots, autoSlot, misc] = await Promise.all<
          ig.SaveSlot.Data[],
          ig.SaveSlot.Data | null,
          ig.StorageDataReadable.MiscData | null
        >([
          Promise.all(
            slotsDirFilenames.map((filename) =>
              readJsonFile<ig.SaveSlot.Data>(path.join(slotsDir, filename)),
            ),
          ),
          readJsonFileOptional(path.join(rootDir, 'autoSlot.json')),
          readJsonFileOptional(path.join(rootDir, 'misc.json')),
        ]);

        return {
          slots,
          autoSlot,
          globals,
          lastSlot: misc != null ? misc.lastSlot : undefined,
        };
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
          // filesystem and making their save file writable, with `chmod` or
          // `chown` for example
          err.message = `An error occured while writing the savegame. Please repair your filesystem immediately!!!\n${err.message}`;
          console.error(err);
        } finally {
          this._onWriteFinished();
        }
      },

      async _writeToDir(rootDir, data) {
        // You know, while writing this I thought of setting file
        // modes/permissions on the save file correctly. Good UNIX citizens
        // usually set 600 (rw-------) permissions on private files and
        // CrossCode savegame can be considered a private file, but since the
        // stock game doesn't do that already and I doubt that many people play
        // CrossCode on multi-user UNIX setups, I believe that this is
        // unnecessary (at least for the time being).

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
        let slotsDirFilenamesToDelete = new Set<string>();
        for (let dirent of await fsp.readdir(slotsDir, {
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
          return fsp.writeFile(path.join(slotsDir, filename), slotData, 'utf8');
        });

        for (let filename of slotsDirFilenamesToDelete) {
          promises.push(fsp.unlink(path.join(slotsDir, filename)));
        }

        promises.push(
          fsp.writeFile(
            path.join(rootDir, 'autoSlot.json'),
            data.autoSlot,
            'utf8',
          ),
          fsp.writeFile(
            path.join(rootDir, 'globals.json'),
            data.globals,
            'utf8',
          ),
          fsp.writeFile(path.join(rootDir, 'misc.json'), data.misc, 'utf8'),
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

        // Right now you might be screaming at your monitor while looking at
        // this code and/or wondering about the following two questions:
        // 1. "Why do you replace the default savegame format?"
        // 2. "Why do you stitch together strings to get serialized JSON?"
        // Bear with me and I'll explain why do I do both of these things.
        //
        // First of all, I believe that save encryption is totally unnecessary
        // for CC, so I naturally want to remove it everywhere. But you might
        // argue that by putting JSON objects directly into the save instead of
        // the encrypted strings would crash the game if it'd try to load the
        // savegame without this mod. Well, you are not entirely correct.
        // Obviously, I have to be careful not to introduce breaking changes
        // into the save format because otherwise the game won't be able to
        // recover from it if this mod is uninstalled. But you see, the
        // storage-related code is filled with checks such as:
        //
        // ```
        // if (ig.StorageTools.isEncrypted(data)) {
        //   data = JSON.parse(ig.StorageTools.decrypt(data));
        // }
        // // continue working with `data`
        // ````
        //
        // So as you can see, even the stock game can run perfectly off of an
        // (even partially) unencrypted save file. Moreover, those checks have
        // always been present (verified by looking into the code of v1.0.1-1
        // and v0.7.0), even way back when `localStorage` was used for storing
        // saves. So it is safe to say that this unencrypted save format is
        // perfectly compatible with virtually any version of the game currently
        // in use.
        //
        // Secondly, I concatenate already serialized strings of save slots
        // here to speed up the overall serialization because serializing this
        // whole object on each write takes too much time, plus save slots
        // aren't really modified internally, so I can precompute their
        // serialized contents.
        this.data.save(
          `{${[
            `"slots":[${this.slots.map((s) => s.stringified).join(',')}]`,
            `"autoSlot":${
              this.autoSlot != null ? this.autoSlot.stringified : 'null'
            }`,
            `"globals":${JSON.stringify(globals)}`,
            `"lastSlot":${this.lastUsedSlot}`,
          ].join(',')}}`,
        );

        this.readableData.save({
          slots: this.slots.map((s) => s.stringifiedPretty),
          autoSlot:
            this.autoSlot != null ? this.autoSlot.stringifiedPretty : 'null',
          globals: stringifyPretty(globals),
          misc: stringifyPretty({ lastSlot: this.lastUsedSlot }),
        });

        return {
          slots: this.slots.map((slot) => slot.data),
          autoSlot: this.autoSlot != null ? this.autoSlot.data : null,
          globals,
          lastSlot: this.lastUsedSlot,
        };
      },
    });
  });
