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
      path: null,
      saveInProgress: false,
      queuedSaveData: null,

      init(p) {
        this.path = p;
      },

      save(data) {
        if (!this.saveInProgress) this._writeToDisk(data);
        else this.queuedSaveData = data;
      },

      async _writeToDisk(data) {
        this.saveInProgress = true;

        try {
          let rootDir = path.join(
            this.constructor.GAME_DATA_DIRECTORIES[0],
            'cc-readable-save',
          );

          // TODO: explain file modes

          // first of all, I create the directory structure in correct order
          await mkdirIfNotExists(rootDir);
          let slotsDir = path.join(rootDir, 'slots');
          await mkdirIfNotExists(slotsDir);

          let slotFileDigits = Math.max(2, countDigits(data.slots.length));

          // now that all directories have been created, I can fire up all
          // actual file writes in parallel FOR MASSIVE PERFORMANCE BOOST
          await Promise.all([
            ...data.slots.map((slotData, index) => {
              let indexStr = index.toString(10).padStart(slotFileDigits, '0');
              let filename = `${indexStr}.json`;
              return fs.writeFile(path.join(slotsDir, filename), slotData);
            }),
            fs.writeFile(path.join(rootDir, 'autoSlot.json'), data.autoSlot),
            fs.writeFile(path.join(rootDir, 'globals.json'), data.globals),
            fs.writeFile(path.join(rootDir, 'misc.json'), data.misc),
          ]);
        } catch (err) {
          // note that here I don't crash the game with `ig.system.error`
          // because user might still have the chance of fixing their
          // filesystem and making their savefile writable, with `chmod` or
          // `chown` for example
          console.error(err);
        }

        this._onWriteFinished();
      },

      _onWriteFinished() {
        if (this.queuedSaveData != null) {
          let data = this.queuedSaveData;
          this.queuedSaveData = null;
          this._writeToDisk(data);
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
      readableData: new ig.StorageDataReadable('cc-readable-save.json'),

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
