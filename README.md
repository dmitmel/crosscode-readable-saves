# crosscode-readable-saves

[![go to the releases page](https://raw.githubusercontent.com/CCDirectLink/organization/master/assets/badges/releases@2x.png)](https://github.com/dmitmel/crosscode-readable-saves/releases)

A mod which improves the [savegame format](https://crosscode.gamepedia.com/Savegame) of CrossCode
by:

1. Disabling encryption (decryption is still in place, so your old save file will be imported
   without any problems)
2. Writing the slots and the game options in separate JSON files (which are easily editable) into
   the `cc-readable-save` directory alongside your regular save file

## Overview of the default save format

First of all, here's some information about the regular save file. It is located in:

| System     | Path                                                      |
| ---------- | --------------------------------------------------------- |
| MS Windows | `%LOCALAPPDATA%\CrossCode\cc.save`                        |
| macOS      | `~/Library/Application Support/CrossCode/Default/cc.save` |
| GNU/Linux  | `~/.config/CrossCode/Default/cc.save`                     |

It's default format is
([taken from the CrossCode wiki](https://crosscode.gamepedia.com/Savegame#Savefile_and_Localstorage_format),
see that page for more info):

<!-- prettier-ignore -->
```json5
{
  "slots": [
    "{encrypted slot 1}",
    "{encrypted slot 2}",
    "{encrypted slot 3}",
    // ...
    "{encrypted slot N}",
  ],
  "autoSlot": "{encrypted}",
  "globals": "{encrypted}",   // game options and trophies/achievements
  "lastSlot": -1              // last loaded slot, slot index or -1 if that was the auto slot
}
```

Encrypted strings always start with `[-!_0_!-]`, the rest is JSON data encrypted with
[AES-256](https://en.wikipedia.org/wiki/Advanced_Encryption_Standard) (in
[CBC mode](<https://en.wikipedia.org/wiki/Block_cipher_mode_of_operation#Cipher_block_chaining_(CBC)>))
and then encoded with [Base64](https://en.wikipedia.org/wiki/Base64). The password used for AES
encryption is already known since May 2016:

<details><summary>Click to reveal the password (unless you want the challenge of figuring it out by reverse-engineering the game)</summary><p>

`:_.NaN0`

</p></details>

## Functionality of this mod

Alright, so you probably get the general details about the default format, now allow me to introduce
the two readable save formats used by this mod. First of all I should note that by default the game
absolutely supports unencrypted save slots and globals data. Why? You see, the save loading code is
filled with checks like (expressed in pseudo-code):

```python
data = get_slot_data()
if is_encrypted(data):
  data = parse_json(decrypt(data))
process_data(data)
```

So as you can see, **if I put regular JSON objects in the save file** instead of running them
through this bizarre encryption pipeline, **the save file will remain 100% compatible with the
regular game**. _&lt;rant&gt;_ Code like this was present even way back when `localStorage` (with
its 5 MB limitation) was used for storing save data. Why haven't developers still simply thrown the
encryption out yet? _Hell if I know!_ Moreover, skipping the encryption actually makes save files
smaller! You see, AES (as any other encryption algorithm) spits out raw binary data which messes
with common text encodings, something is needed to raw binary data in a form which can be
represented and transmitted universally, which is where Base64 comes in. Base64 encodes any data
with plain [ASCII](https://en.wikipedia.org/wiki/ASCII) characters `A-Z`, `a-z`, `0-9`, `+`, `/` and
`=`. However, it does that at the expense of file size because each 3 bytes are encoded with 4
characters. Hence, by skipping the encryption altogether I can make the savegame smaller by one
third (~33%)! It also improves compression ratios because compression algorithms deal better with
data which contains a lot of repeating patterns (since those patterns can be easily folded together)
and encrypted base64-encoded data looks practically random to any compression algorithm.
Additionally, I sped up the start up time a bit because AES encryption is a relatively time- and
processing power-consuming operation. Oh, almost forgot to mention: this makes it easy to write
scripts for reading and manipulating your save files (you cheater) with tools like
[jq](https://stedolan.github.io/jq/). _&lt;/rant&gt;_

As you can see, the advantages of unencryption are obvious and there are no disadvantages (even
incompatibility problems) other than messing with existing save editors which don't (yet) include
`if encrypted only then decrypt` checks. One of the functions of this mod is disabling the save
encryption. Note that I didn't disable decryption, so your regular save file will be imported
without any problems.

Next up, the real deal. Even unencrypted save files can reach the size of several (if not tens of)
megabytes. As not everyone uses tiny text editors like [Vim](https://www.vim.org/) or
[nano](https://www.nano-editor.org/) I firgured that I might as well add a supplementary save format
which puts different slots into separate files and is written in parallel with the regular save
file. This mod adds a new `cc-readable-save` directory which is located next to your the default
file, that is:

| System     | Path                                                                |
| ---------- | ------------------------------------------------------------------- |
| MS Windows | `%LOCALAPPDATA%\CrossCode\cc-readable-save\`                        |
| macOS      | `~/Library/Application Support/CrossCode/Default/cc-readable-save/` |
| GNU/Linux  | `~/.config/CrossCode/Default/cc.save/cc-readable-save/`             |

Its structure is as follows:

```
cc-readable-save/
├─ slots/
│  ├─ 00.json
│  ├─ 01.json
│  ├─ 02.json
│ ...
│  └─ NN.json
├─ autoSlot.json
├─ globals.json
└─ misc.json
```

This should be pretty self-descriptive. `slots/` directory contains save slots, `autoSlot.json` is
the auto slot (or simply contains the text `null` if there is no auto slot), `globals.json` contains
the globals data and `misc.json` contains `lastSlot` along with any other fields which may be added
in the future. Unlike the regular save file these files are written in a so-called "formatted" form,
in other words with all spaces and identination, so you don't even need a JSON beautifier to edit
them. Moreover, you can drop additional save slots into the slots directory and they will be
imported automatically after you launch the game. Deleted slots are deleted on disk as well. Note
that the slots are read in the [ASCII](https://en.wikipedia.org/wiki/ASCII) sort order, so numbers
in the file names are used to correctly preserve the order of all of the slots.

## Caveats

First of all: **the readable save files are not backed up!** That's because the regular save file is
still written to the disk and it already has a backup system, so if you mess up your
`cc-readable-save` directory you can always delete it and the save data will be restored from the
regular save. And yes, **the readable save has priority over the regular file** (in other words, if
a readable save exists it will be loaded instead of the regular one) to allow you to easily edit
save data. **Readable saves are also not synced with Steam Cloud** because naturally they are bigger
than the original save and it already contains your data, so there is no need to push it to the
cloud twice. I also have to mention that **there is a small performance cost to writing all of those
readable files**, but it should usually be unnoticeable.

## Contributing

To set up the development environment run:

```bash
npm install
npm run build

# or:
yarn install
yarn run build
```

I also recommend cloning
[`ultimate-crosscode-typedefs`](https://github.com/dmitmel/ultimate-crosscode-typedefs) somewhere
and linking it to this package using:

```bash
cd path/to/ultimate-crosscode-typedefs
npm link
cd path/to/crosscode-readable-saves
npm link ultimate-crosscode-typedefs

# or:
cd path/to/ultimate-crosscode-typedefs
yarn link
cd path/to/crosscode-readable-saves
yarn link ultimate-crosscode-typedefs
```

So that you can easily add TS definitions if needed.

## License

See the [`LICENSE`](https://github.com/dmitmel/crosscode-readable-saves/blob/master/LICENSE) file.
