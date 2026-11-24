// Tracks bundled with the site (public/audio), 128 kbps AAC. Order matches ring v1's song picker.
const TRACKS = [
  ['baiana', 'Baiana'],
  ['carambolage', 'Carambolage'],
  ['dexter', 'Dexter'],
  ['drava', 'Drava'],
  ['eventually', 'Eventually'],
  ['gymnopedie', 'Gymnopedie'],
  ['itsthattime', 'Its That Time'],
  ['lost', 'Lost'],
  ['mojemilo', 'Moje Milo'],
  ['not', 'Not'],
  ['objemi', 'Neskoncno dolgi objemi'],
  ['pager', 'Looking at you pager'],
  ['rumble', 'Rumble'],
  ['style', 'Style'],
  ['sunshine', 'Everybody loves the sunshine'],
  ['tobogan', 'Tobogan', 'mp3'],
];

export const LIBRARY = TRACKS.map(([id, title, ext = 'm4a']) => ({
  kind: 'url',
  id,
  shareId: `lib:${id}`,
  title,
  subtitle: 'Ring library',
  src: `/audio/${id}.${ext}`,
}));
