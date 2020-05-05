declare namespace ig {
  interface SaveSlot {
    stringified: string;
    stringifiedPretty: string;
  }

  namespace StorageDataReadable {
    interface MiscData {
      lastSlot: number;
    }

    interface SaveDataBlock {
      slots: string[];
      autoSlot: string;
      globals: string;
      misc: string;
    }
  }
  interface StorageDataReadable extends ig.Class, ig.Resource {
    loaded: boolean;
    loadedData: ig.StorageData.SaveFileData | null;
    saveInProgress: boolean;
    queuedSaveData: ig.StorageDataReadable.SaveDataBlock | null;

    _readFromDir(
      this: this,
      rootDir: string,
    ): Promise<ig.StorageData.SaveFileData | null>;
    save(this: this, data: ig.StorageDataReadable.SaveDataBlock): void;
    _write(this: this, data: ig.StorageDataReadable.SaveDataBlock): void;
    _writeToDir(
      this: this,
      rootDir: string,
      data: ig.StorageDataReadable.SaveDataBlock,
    ): void;
    _onWriteFinished(this: this): void;
  }
  interface StorageDataReadableConstructor
    extends ImpactClass<StorageDataReadable> {
    GAME_DATA_DIRECTORIES: string[];

    new (): this['__instance'];
  }
  let StorageDataReadable: StorageDataReadableConstructor;

  interface Storage {
    readableData: StorageDataReadable;
  }
}
