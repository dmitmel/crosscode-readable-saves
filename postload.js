if (ig.platform !== ig.PLATFORM_TYPES.DESKTOP) {
  throw new Error('only desktop is supported');
}

ig.module('readable-saves')
  .requires('impact.feature.storage.storage')
  .defines(() => {
    const fs = require('fs');
    const path = require('path');

    function serializePretty(data) {
      return JSON.stringify(data, null, 2);
    }

    ig.StorageDataSimple = ig.StorageData.extend({
      _saveToFile() {
        // save immediately, skip renaming backup files
        this._doIoStep({ save: true });
      },

      // Dammit, RFG, why don't you just print error stack traces by default?
      // That's what the console is for.
      _loadResponse(err, ...args) {
        if (err != null && err.code !== 'ENOENT') {
          console.error(err);
          this._loadCallback(this.cacheType, this.path, false);
          // yes, this second throw does look weird, but _loadCallback itself
          // indirectly throws an error if the last flag is `false`
          throw err;
        }
        return this.parent(err, ...args);
      },

      _saveResponse(err, ...args) {
        // Where does this error usually end up? Correct: it isn't shown to the
        // user, but the user definitely has the right to know what happens to
        // their save files, hence the `console.error`
        if (err != null) {
          // note that here I don't crash the game with `ig.system.error`
          // because user might still have the chance to make their savefile
          // readable, with `chmod` or `chown` for example
          console.error(err);
          // reset the error so that data of this `ig.StorageData` instance
          // isn't written into `localStorage` (there is no point), but
          // subsequent writes to the disk are still executed
          err = null;
        }
        return this.parent(err, ...args);
      },

      _getSaveFilePathList() {
        let pathList = [];

        // On Windows `nw.App.dataPath` is `%LOCALAPPDATA%\CrossCode\User Data\Default`,
        // yet the game writes the savegame to `%LOCALAPPDATA%\CrossCode` when
        // possible, so I reproduce this behavior. Notice that this
        // implementation IS BROKEN when %LOCALAPPDATA% contains the
        // `\User Data\Default` substring, but eh, whatever, this is the exact
        // piece of code the stock game uses.
        let { dataPath } = nw.App;
        let userDataIndex = dataPath.indexOf('\\User Data\\Default');
        if (userDataIndex >= 0) {
          let dataPathRoot = dataPath.slice(0, userDataIndex);
          pathList.push(path.join(dataPathRoot, this.path));
        }
        pathList.push(path.join(dataPath, this.path));

        return pathList;
      },

      _loadStorageFromData(text) {
        try {
          this.data = JSON.parse(text);
        } catch (err) {
          err.message = `Failed to parse ${this.path}: ${err.message}`;
          ig.system.error(err);
          return false;
        }

        // skip the decryption and JSON parsing in the original implementation
        // by passing an empty string because it has an if which checks if
        // `text` is truthy
        this.parent('');
      },
    });

    ig.Storage.inject({
      readableData: new ig.StorageDataSimple('cc-readable-save.json'),

      init(...args) {
        if (this.readableData.data != null) {
          let oldData = this.data.data;
          this.data.data = this.readableData.data;
          this.parent(...args);
          this.data.data = oldData;
        } else {
          this.parent(...args);
        }
      },

      _saveToStorage(...args) {
        let globals = null;

        // usually globals listeners are used for constructing the `globals`
        // object, but here I take advantage of them and use a listener to read
        // the state of globals instead.
        let fakeGlobalsListener = {
          onStorageGlobalSave: (globals2) => {
            globals = globals2;
          },
        };

        this.listeners.push(fakeGlobalsListener);
        let result = this.parent(...args);
        this.listeners.pop();

        this.readableData.save(
          serializePretty({
            slots: this.slots.map((slot) => slot.data),
            autoSlot: this.autoSlot.data,
            globals,
            lastSlot: this.lastUsedSlot,
          }),
        );

        return result;
      },
    });
  });
