// this check has to be done in a separate module so that it is performed before
// importing `fs` and `path` and gives a more informative error message
if (ig.platform !== ig.PLATFORM_TYPES.DESKTOP) {
  throw new Error('only desktop is supported');
}
