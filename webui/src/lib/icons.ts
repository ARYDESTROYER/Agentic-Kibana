/**
 * Static EUI icon registration.
 *
 * EUI ships every glyph as a lazily `import()`-ed chunk. In the nginx-served
 * production bundle those dynamic chunks do not resolve, so every <EuiIcon>
 * (and the icon chrome inside tables, date pickers, flyouts, comboboxes, ...)
 * renders as a blank gray square. Pre-registering the icons the app uses via
 * `appendIconComponentCache` makes EUI resolve them synchronously from the
 * bundle instead of fetching a chunk at runtime.
 *
 * This module is imported for its side effect at the very top of `main.tsx`,
 * before React renders, so the cache is warm on first paint.
 *
 * The set below = every icon `type` grepped from `src/` PLUS the common chrome
 * icons EUI's own internal components need (tables, date pickers, flyouts,
 * comboboxes, pagination, sortable headers). To add an icon, register its
 * camelCase `type` here; the asset file name is snake_case (see
 * `@elastic/eui/es/components/icon/icon_map.js` for the type->file mapping).
 */
import { appendIconComponentCache } from '@elastic/eui/es/components/icon/icon';
import { icon as app_dashboard } from '@elastic/eui/es/components/icon/assets/app_dashboard';
import { icon as app_discover } from '@elastic/eui/es/components/icon/assets/app_discover';
import { icon as app_graph } from '@elastic/eui/es/components/icon/assets/app_graph';
import { icon as app_ml } from '@elastic/eui/es/components/icon/assets/app_ml';
import { icon as app_pipeline } from '@elastic/eui/es/components/icon/assets/app_pipeline';
import { icon as app_reporting } from '@elastic/eui/es/components/icon/assets/app_reporting';
import { icon as app_security } from '@elastic/eui/es/components/icon/assets/app_security';
import { icon as arrowEnd } from '@elastic/eui/es/components/icon/assets/arrowEnd';
import { icon as arrowStart } from '@elastic/eui/es/components/icon/assets/arrowStart';
import { icon as arrow_down } from '@elastic/eui/es/components/icon/assets/arrow_down';
import { icon as arrow_left } from '@elastic/eui/es/components/icon/assets/arrow_left';
import { icon as arrow_right } from '@elastic/eui/es/components/icon/assets/arrow_right';
import { icon as arrow_up } from '@elastic/eui/es/components/icon/assets/arrow_up';
import { icon as article } from '@elastic/eui/es/components/icon/assets/article';
import { icon as beaker } from '@elastic/eui/es/components/icon/assets/beaker';
import { icon as bell } from '@elastic/eui/es/components/icon/assets/bell';
import { icon as boxes_vertical } from '@elastic/eui/es/components/icon/assets/boxes_vertical';
import { icon as branch } from '@elastic/eui/es/components/icon/assets/branch';
import { icon as brush } from '@elastic/eui/es/components/icon/assets/brush';
import { icon as bug } from '@elastic/eui/es/components/icon/assets/bug';
import { icon as calendar } from '@elastic/eui/es/components/icon/assets/calendar';
import { icon as check } from '@elastic/eui/es/components/icon/assets/check';
import { icon as checkInCircleFilled } from '@elastic/eui/es/components/icon/assets/checkInCircleFilled';
import { icon as clock } from '@elastic/eui/es/components/icon/assets/clock';
import { icon as cluster } from '@elastic/eui/es/components/icon/assets/cluster';
import { icon as compute } from '@elastic/eui/es/components/icon/assets/compute';
import { icon as console } from '@elastic/eui/es/components/icon/assets/console';
import { icon as copy_clipboard } from '@elastic/eui/es/components/icon/assets/copy_clipboard';
import { icon as cross } from '@elastic/eui/es/components/icon/assets/cross';
import { icon as cross_in_circle } from '@elastic/eui/es/components/icon/assets/cross_in_circle';
import { icon as crosshairs } from '@elastic/eui/es/components/icon/assets/crosshairs';
import { icon as currency } from '@elastic/eui/es/components/icon/assets/currency';
import { icon as database } from '@elastic/eui/es/components/icon/assets/database';
import { icon as desktop } from '@elastic/eui/es/components/icon/assets/desktop';
import { icon as discuss } from '@elastic/eui/es/components/icon/assets/discuss';
import { icon as document } from '@elastic/eui/es/components/icon/assets/document';
import { icon as documentEdit } from '@elastic/eui/es/components/icon/assets/documentEdit';
import { icon as documentation } from '@elastic/eui/es/components/icon/assets/documentation';
import { icon as documents } from '@elastic/eui/es/components/icon/assets/documents';
import { icon as dot } from '@elastic/eui/es/components/icon/assets/dot';
import { icon as doubleArrowLeft } from '@elastic/eui/es/components/icon/assets/doubleArrowLeft';
import { icon as doubleArrowRight } from '@elastic/eui/es/components/icon/assets/doubleArrowRight';
import { icon as download } from '@elastic/eui/es/components/icon/assets/download';
import { icon as editor_comment } from '@elastic/eui/es/components/icon/assets/editor_comment';
import { icon as empty } from '@elastic/eui/es/components/icon/assets/empty';
import { icon as error } from '@elastic/eui/es/components/icon/assets/error';
import { icon as exit } from '@elastic/eui/es/components/icon/assets/exit';
import { icon as expand } from '@elastic/eui/es/components/icon/assets/expand';
import { icon as exportIcon } from '@elastic/eui/es/components/icon/assets/export';
import { icon as eye } from '@elastic/eui/es/components/icon/assets/eye';
import { icon as eye_closed } from '@elastic/eui/es/components/icon/assets/eye_closed';
import { icon as face_happy } from '@elastic/eui/es/components/icon/assets/face_happy';
import { icon as face_neutral } from '@elastic/eui/es/components/icon/assets/face_neutral';
import { icon as face_sad } from '@elastic/eui/es/components/icon/assets/face_sad';
import { icon as filter } from '@elastic/eui/es/components/icon/assets/filter';
import { icon as folder_closed } from '@elastic/eui/es/components/icon/assets/folder_closed';
import { icon as folder_open } from '@elastic/eui/es/components/icon/assets/folder_open';
import { icon as fullScreenExit } from '@elastic/eui/es/components/icon/assets/fullScreenExit';
import { icon as full_screen } from '@elastic/eui/es/components/icon/assets/full_screen';
import { icon as gear } from '@elastic/eui/es/components/icon/assets/gear';
import { icon as globe } from '@elastic/eui/es/components/icon/assets/globe';
import { icon as iInCircle } from '@elastic/eui/es/components/icon/assets/iInCircle';
import { icon as importIcon } from '@elastic/eui/es/components/icon/assets/import';
import { icon as index_mapping } from '@elastic/eui/es/components/icon/assets/index_mapping';
import { icon as inspect } from '@elastic/eui/es/components/icon/assets/inspect';
import { icon as layers } from '@elastic/eui/es/components/icon/assets/layers';
import { icon as link } from '@elastic/eui/es/components/icon/assets/link';
import { icon as list } from '@elastic/eui/es/components/icon/assets/list';
import { icon as lock } from '@elastic/eui/es/components/icon/assets/lock';
import { icon as lockOpen } from '@elastic/eui/es/components/icon/assets/lockOpen';
import { icon as logstash_if } from '@elastic/eui/es/components/icon/assets/logstash_if';
import { icon as logstash_queue } from '@elastic/eui/es/components/icon/assets/logstash_queue';
import { icon as map_marker } from '@elastic/eui/es/components/icon/assets/map_marker';
import { icon as memory } from '@elastic/eui/es/components/icon/assets/memory';
import { icon as menuDown } from '@elastic/eui/es/components/icon/assets/menuDown';
import { icon as menuLeft } from '@elastic/eui/es/components/icon/assets/menuLeft';
import { icon as menuRight } from '@elastic/eui/es/components/icon/assets/menuRight';
import { icon as menuUp } from '@elastic/eui/es/components/icon/assets/menuUp';
import { icon as minus_in_circle } from '@elastic/eui/es/components/icon/assets/minus_in_circle';
import { icon as minus_in_circle_filled } from '@elastic/eui/es/components/icon/assets/minus_in_circle_filled';
import { icon as moon } from '@elastic/eui/es/components/icon/assets/moon';
import { icon as namespace } from '@elastic/eui/es/components/icon/assets/namespace';
import { icon as number } from '@elastic/eui/es/components/icon/assets/number';
import { icon as packageIcon } from '@elastic/eui/es/components/icon/assets/package';
import { icon as pageSelect } from '@elastic/eui/es/components/icon/assets/pageSelect';
import { icon as pagesSelect } from '@elastic/eui/es/components/icon/assets/pagesSelect';
import { icon as pencil } from '@elastic/eui/es/components/icon/assets/pencil';
import { icon as play } from '@elastic/eui/es/components/icon/assets/play';
import { icon as plus } from '@elastic/eui/es/components/icon/assets/plus';
import { icon as plus_in_circle } from '@elastic/eui/es/components/icon/assets/plus_in_circle';
import { icon as plus_in_circle_filled } from '@elastic/eui/es/components/icon/assets/plus_in_circle_filled';
import { icon as popout } from '@elastic/eui/es/components/icon/assets/popout';
import { icon as question_in_circle } from '@elastic/eui/es/components/icon/assets/question_in_circle';
import { icon as refresh } from '@elastic/eui/es/components/icon/assets/refresh';
import { icon as return_key } from '@elastic/eui/es/components/icon/assets/return_key';
import { icon as save } from '@elastic/eui/es/components/icon/assets/save';
import { icon as search } from '@elastic/eui/es/components/icon/assets/search';
import { icon as sortAscending } from '@elastic/eui/es/components/icon/assets/sortAscending';
import { icon as sortDescending } from '@elastic/eui/es/components/icon/assets/sortDescending';
import { icon as sortLeft } from '@elastic/eui/es/components/icon/assets/sortLeft';
import { icon as sortRight } from '@elastic/eui/es/components/icon/assets/sortRight';
import { icon as sort_down } from '@elastic/eui/es/components/icon/assets/sort_down';
import { icon as sort_up } from '@elastic/eui/es/components/icon/assets/sort_up';
import { icon as sortable } from '@elastic/eui/es/components/icon/assets/sortable';
import { icon as star_empty } from '@elastic/eui/es/components/icon/assets/star_empty';
import { icon as star_filled } from '@elastic/eui/es/components/icon/assets/star_filled';
import { icon as stats } from '@elastic/eui/es/components/icon/assets/stats';
import { icon as storage } from '@elastic/eui/es/components/icon/assets/storage';
import { icon as sun } from '@elastic/eui/es/components/icon/assets/sun';
import { icon as table_density_compact } from '@elastic/eui/es/components/icon/assets/table_density_compact';
import { icon as table_density_expanded } from '@elastic/eui/es/components/icon/assets/table_density_expanded';
import { icon as table_density_normal } from '@elastic/eui/es/components/icon/assets/table_density_normal';
import { icon as tag } from '@elastic/eui/es/components/icon/assets/tag';
import { icon as timeRefresh } from '@elastic/eui/es/components/icon/assets/timeRefresh';
import { icon as trash } from '@elastic/eui/es/components/icon/assets/trash';
import { icon as user } from '@elastic/eui/es/components/icon/assets/user';
import { icon as userAvatar } from '@elastic/eui/es/components/icon/assets/userAvatar';
import { icon as users } from '@elastic/eui/es/components/icon/assets/users';
import { icon as vis_area } from '@elastic/eui/es/components/icon/assets/vis_area';
import { icon as vis_bar_vertical } from '@elastic/eui/es/components/icon/assets/vis_bar_vertical';
import { icon as vis_bar_vertical_stacked } from '@elastic/eui/es/components/icon/assets/vis_bar_vertical_stacked';
import { icon as vis_gauge } from '@elastic/eui/es/components/icon/assets/vis_gauge';
import { icon as vis_line } from '@elastic/eui/es/components/icon/assets/vis_line';
import { icon as vis_pie } from '@elastic/eui/es/components/icon/assets/vis_pie';
import { icon as vis_table } from '@elastic/eui/es/components/icon/assets/vis_table';
import { icon as vis_text } from '@elastic/eui/es/components/icon/assets/vis_text';
import { icon as warning } from '@elastic/eui/es/components/icon/assets/warning';
import { icon as wordWrap } from '@elastic/eui/es/components/icon/assets/wordWrap';
import { icon as wrench } from '@elastic/eui/es/components/icon/assets/wrench';
// --- Additional coverage for the new source/index/entity UI (verified present in
// node_modules/@elastic/eui/.../assets; camelCase->snake_case per icon_map.js). ---
import { icon as apps } from '@elastic/eui/es/components/icon/assets/apps';
import { icon as at } from '@elastic/eui/es/components/icon/assets/at';
import { icon as bolt } from '@elastic/eui/es/components/icon/assets/bolt';
import { icon as boxes_horizontal } from '@elastic/eui/es/components/icon/assets/boxes_horizontal';
import { icon as color } from '@elastic/eui/es/components/icon/assets/color';
import { icon as controls_horizontal } from '@elastic/eui/es/components/icon/assets/controls_horizontal';
import { icon as controls_vertical } from '@elastic/eui/es/components/icon/assets/controls_vertical';
import { icon as copy } from '@elastic/eui/es/components/icon/assets/copy';
import { icon as dotInCircle } from '@elastic/eui/es/components/icon/assets/dotInCircle';
import { icon as email } from '@elastic/eui/es/components/icon/assets/email';
import { icon as eql } from '@elastic/eui/es/components/icon/assets/eql';
import { icon as errorFilled } from '@elastic/eui/es/components/icon/assets/errorFilled';
import { icon as filterInCircle } from '@elastic/eui/es/components/icon/assets/filterInCircle';
import { icon as flag } from '@elastic/eui/es/components/icon/assets/flag';
import { icon as fold } from '@elastic/eui/es/components/icon/assets/fold';
import { icon as grab } from '@elastic/eui/es/components/icon/assets/grab';
import { icon as grab_horizontal } from '@elastic/eui/es/components/icon/assets/grab_horizontal';
import { icon as grid } from '@elastic/eui/es/components/icon/assets/grid';
import { icon as heatmap } from '@elastic/eui/es/components/icon/assets/heatmap';
import { icon as help } from '@elastic/eui/es/components/icon/assets/help';
import { icon as home } from '@elastic/eui/es/components/icon/assets/home';
import { icon as index } from '@elastic/eui/es/components/icon/assets/index';
import { icon as indexTemporary } from '@elastic/eui/es/components/icon/assets/indexTemporary';
import { icon as invert } from '@elastic/eui/es/components/icon/assets/invert';
import { icon as ip } from '@elastic/eui/es/components/icon/assets/ip';
import { icon as key } from '@elastic/eui/es/components/icon/assets/key';
import { icon as kql_field } from '@elastic/eui/es/components/icon/assets/kql_field';
import { icon as launch } from '@elastic/eui/es/components/icon/assets/launch';
import { icon as list_add } from '@elastic/eui/es/components/icon/assets/list_add';
import { icon as magnifyWithMinus } from '@elastic/eui/es/components/icon/assets/magnifyWithMinus';
import { icon as magnifyWithPlus } from '@elastic/eui/es/components/icon/assets/magnifyWithPlus';
import { icon as menu } from '@elastic/eui/es/components/icon/assets/menu';
import { icon as merge } from '@elastic/eui/es/components/icon/assets/merge';
import { icon as move } from '@elastic/eui/es/components/icon/assets/move';
import { icon as nested } from '@elastic/eui/es/components/icon/assets/nested';
import { icon as new_chat } from '@elastic/eui/es/components/icon/assets/new_chat';
import { icon as node } from '@elastic/eui/es/components/icon/assets/node';
import { icon as offline } from '@elastic/eui/es/components/icon/assets/offline';
import { icon as online } from '@elastic/eui/es/components/icon/assets/online';
import { icon as paper_clip } from '@elastic/eui/es/components/icon/assets/paper_clip';
import { icon as partial } from '@elastic/eui/es/components/icon/assets/partial';
import { icon as percent } from '@elastic/eui/es/components/icon/assets/percent';
import { icon as pin } from '@elastic/eui/es/components/icon/assets/pin';
import { icon as pin_filled } from '@elastic/eui/es/components/icon/assets/pin_filled';
import { icon as push } from '@elastic/eui/es/components/icon/assets/push';
import { icon as share } from '@elastic/eui/es/components/icon/assets/share';
import { icon as sparkles } from '@elastic/eui/es/components/icon/assets/sparkles';
import { icon as tableOfContents } from '@elastic/eui/es/components/icon/assets/tableOfContents';
import { icon as unfold } from '@elastic/eui/es/components/icon/assets/unfold';
import { icon as vis_bar_horizontal } from '@elastic/eui/es/components/icon/assets/vis_bar_horizontal';
import { icon as vis_bar_horizontal_stacked } from '@elastic/eui/es/components/icon/assets/vis_bar_horizontal_stacked';
import { icon as vis_metric } from '@elastic/eui/es/components/icon/assets/vis_metric';
import { icon as warningFilled } from '@elastic/eui/es/components/icon/assets/warningFilled';

// Map each EUI icon `type` (camelCase) to its imported component. Multiple
// types may share one asset (e.g. `alert` is an alias for `warning`).
appendIconComponentCache({
  alert: warning,
  link: link,
  arrowDown: arrow_down,
  arrowEnd: arrowEnd,
  arrowLeft: arrow_left,
  arrowRight: arrow_right,
  arrowStart: arrowStart,
  arrowUp: arrow_up,
  article: article,
  beaker: beaker,
  bell: bell,
  boxesVertical: boxes_vertical,
  branch: branch,
  brush: brush,
  bug: bug,
  calendar: calendar,
  check: check,
  checkInCircleFilled: checkInCircleFilled,
  clock: clock,
  cluster: cluster,
  compute: compute,
  console: console,
  copyClipboard: copy_clipboard,
  cross: cross,
  crossInCircle: cross_in_circle,
  crosshairs: crosshairs,
  currency: currency,
  dashboardApp: app_dashboard,
  database: database,
  desktop: desktop,
  discoverApp: app_discover,
  discuss: discuss,
  document: document,
  documentEdit: documentEdit,
  documentation: documentation,
  documents: documents,
  dot: dot,
  doubleArrowLeft: doubleArrowLeft,
  doubleArrowRight: doubleArrowRight,
  download: download,
  editorComment: editor_comment,
  empty: empty,
  error: error,
  exit: exit,
  expand: expand,
  exportAction: exportIcon,
  eye: eye,
  eyeClosed: eye_closed,
  faceHappy: face_happy,
  faceNeutral: face_neutral,
  faceSad: face_sad,
  filter: filter,
  folderClosed: folder_closed,
  folderOpen: folder_open,
  fullScreen: full_screen,
  fullScreenExit: fullScreenExit,
  gear: gear,
  globe: globe,
  graphApp: app_graph,
  iInCircle: iInCircle,
  importAction: importIcon,
  indexMapping: index_mapping,
  inspect: inspect,
  layers: layers,
  list: list,
  lock: lock,
  lockOpen: lockOpen,
  logstashIf: logstash_if,
  logstashQueue: logstash_queue,
  machineLearningApp: app_ml,
  mapMarker: map_marker,
  memory: memory,
  menuDown: menuDown,
  menuLeft: menuLeft,
  menuRight: menuRight,
  menuUp: menuUp,
  minusInCircle: minus_in_circle,
  minusInCircleFilled: minus_in_circle_filled,
  moon: moon,
  namespace: namespace,
  number: number,
  package: packageIcon,
  pageSelect: pageSelect,
  pagesSelect: pagesSelect,
  pencil: pencil,
  pipelineApp: app_pipeline,
  play: play,
  plus: plus,
  plusInCircle: plus_in_circle,
  plusInCircleFilled: plus_in_circle_filled,
  popout: popout,
  questionInCircle: question_in_circle,
  refresh: refresh,
  reportingApp: app_reporting,
  returnKey: return_key,
  save: save,
  search: search,
  securityApp: app_security,
  sortAscending: sortAscending,
  sortDescending: sortDescending,
  sortDown: sort_down,
  sortLeft: sortLeft,
  sortRight: sortRight,
  sortUp: sort_up,
  sortable: sortable,
  starEmpty: star_empty,
  starFilled: star_filled,
  stats: stats,
  storage: storage,
  sun: sun,
  tableDensityCompact: table_density_compact,
  tableDensityExpanded: table_density_expanded,
  tableDensityNormal: table_density_normal,
  tag: tag,
  timeRefresh: timeRefresh,
  trash: trash,
  user: user,
  userAvatar: userAvatar,
  users: users,
  visArea: vis_area,
  visBarVertical: vis_bar_vertical,
  visBarVerticalStacked: vis_bar_vertical_stacked,
  visGauge: vis_gauge,
  visLine: vis_line,
  visPie: vis_pie,
  visTable: vis_table,
  visText: vis_text,
  warning: warning,
  wordWrap: wordWrap,
  wrench: wrench,
  // --- Additional coverage for the new source/index/entity UI --------------- //
  apps: apps,
  at: at,
  bolt: bolt,
  boxesHorizontal: boxes_horizontal,
  color: color,
  controlsHorizontal: controls_horizontal,
  controlsVertical: controls_vertical,
  copy: copy,
  dotInCircle: dotInCircle,
  email: email,
  eql: eql,
  errorFilled: errorFilled,
  filterInCircle: filterInCircle,
  flag: flag,
  fold: fold,
  grab: grab,
  grabHorizontal: grab_horizontal,
  grid: grid,
  heatmap: heatmap,
  help: help,
  home: home,
  index: index,
  indexTemporary: indexTemporary,
  invert: invert,
  ip: ip,
  key: key,
  kqlField: kql_field,
  launch: launch,
  listAdd: list_add,
  magnifyWithMinus: magnifyWithMinus,
  magnifyWithPlus: magnifyWithPlus,
  menu: menu,
  merge: merge,
  move: move,
  nested: nested,
  newChat: new_chat,
  node: node,
  offline: offline,
  online: online,
  paperClip: paper_clip,
  partial: partial,
  percent: percent,
  pin: pin,
  pinFilled: pin_filled,
  push: push,
  share: share,
  sparkles: sparkles,
  tableOfContents: tableOfContents,
  unfold: unfold,
  visBarHorizontal: vis_bar_horizontal,
  visBarHorizontalStacked: vis_bar_horizontal_stacked,
  visMetric: vis_metric,
  warningFilled: warningFilled,
});
