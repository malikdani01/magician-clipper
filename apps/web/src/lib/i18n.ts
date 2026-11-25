/**
 * Batch 5 (2026-11-25): Roman Urdu UI.
 *
 * A small i18n dictionary for the app chrome — sidebar, dashboard,
 * jobs, new-job form, wizard headings, library, brand kit, captions
 * studio, settings. Two languages only: English ('en', default) and
 * Roman Urdu ('ur' — Latin script, NEVER Devanagari).
 *
 * What is NOT translated, ever: video titles, captions, clip
 * transcripts and job notes — they stay exactly as they are.
 *
 * A key missing from the Urdu map falls back to English honestly
 * (no blank labels, no fake text) — see `translate()`.
 */

export type Language = 'en' | 'ur'
export type Theme = 'dark' | 'light'

export type TranslationKey =
  | 'navDashboard'
  | 'navMyProjects'
  | 'navVideoLibrary'
  | 'navAiClipper'
  | 'navMyJobs'
  | 'navStudioEditor'
  | 'navCaptionsStudio'
  | 'navBrandKit'
  | 'navExportHistory'
  | 'navUsageCredits'
  | 'navSettings'
  | 'navHelpSupport'
  | 'navAdminPanel'
  | 'searchPlaceholder'
  | 'upgradePlan'
  | 'accountSettings'
  | 'signIn'
  | 'register'
  | 'guestUser'
  | 'themeToggleLight'
  | 'themeToggleDark'
  | 'languageToggle'
  | 'save'
  | 'cancel'
  | 'delete'
  | 'remove'
  | 'back'
  | 'loading'
  | 'ready'
  | 'processing'
  | 'queued'
  | 'failed'
  | 'cancelled'
  | 'download'
  | 'downloadAll'
  | 'createJob'
  | 'view'
  | 'copy'
  | 'copied'
  | 'retry'
  | 'search'
  | 'upload'
  | 'close'
  | 'edit'
  | 'favourite'
  | 'dashboardTitle'
  | 'dashboardSubtitle'
  | 'statJobs'
  | 'statClips'
  | 'statStorage'
  | 'statFavourites'
  | 'recentJobs'
  | 'topClips'
  | 'whatWorksBest'
  | 'noJobsYet'
  | 'createFirstJob'
  | 'mostViralClip'
  | 'jobsTitle'
  | 'jobsSubtitle'
  | 'searchJobs'
  | 'statusFilter'
  | 'allStatuses'
  | 'noJobsFound'
  | 'showingJobs'
  | 'newJobTitle'
  | 'newJobSubtitle'
  | 'sourceVideo'
  | 'uploadVideo'
  | 'videoLink'
  | 'platform'
  | 'aspectRatio'
  | 'captionStyle'
  | 'captionPosition'
  | 'clipDuration'
  | 'clipCount'
  | 'jobType'
  | 'campaignRequirements'
  | 'notes'
  | 'createJobBtn'
  | 'bulkJobs'
  | 'chooseFile'
  | 'pasteLink'
  | 'wizardStep1'
  | 'wizardStep2'
  | 'wizardStep3'
  | 'chooseSource'
  | 'chooseStyle'
  | 'processTitle'
  | 'libraryTitle'
  | 'librarySubtitle'
  | 'searchLibrary'
  | 'favouritesOnly'
  | 'noClipsYet'
  | 'brandKitTitle'
  | 'brandKitSubtitle'
  | 'introVideo'
  | 'outroVideo'
  | 'logoImage'
  | 'livePreview'
  | 'noAssetYet'
  | 'captionsTitle'
  | 'captionsSubtitle'
  | 'sampleText'
  | 'settingsTitle'
  | 'settingsSubtitle'
  | 'tabProfile'
  | 'tabSecurity'
  | 'tabNotifications'
  | 'tabPreferences'
  | 'tabStorage'
  | 'tabBilling'
  | 'tabCloudStorage'
  | 'appearance'
  | 'themeLabel'
  | 'languageLabel'
  | 'darkTheme'
  | 'lightTheme'
  | 'english'
  | 'romanUrdu'
  | 'saveChanges'
  | 'cloudStorageDesc'
  | 'cloudProvider'
  | 'cloudEndpoint'
  | 'cloudBucket'
  | 'cloudRegion'
  | 'cloudAccessKey'
  | 'cloudSecretKey'
  | 'cloudEnabled'
  | 'testConnection'
  | 'testingConnection'
  | 'connectionOk'
  | 'connectionFailed'
  | 'secretSaved'
  | 'clipsReady'
  | 'jobDetails'
  | 'welcomeBack'
  | 'statProjects'
  | 'statProcessing'
  | 'recentProjects'
  | 'gettingStarted'
  | 'recentExports'
  | 'quickActions'
  | 'recentActivity'
  | 'viewAll'
  | 'noProjectsYet'

const EN: Record<TranslationKey, string> = {
  navDashboard: 'Dashboard',
  navMyProjects: 'My Projects',
  navVideoLibrary: 'Video Library',
  navAiClipper: 'AI Clipper',
  navMyJobs: 'My Jobs',
  navStudioEditor: 'Studio Editor',
  navCaptionsStudio: 'Captions Studio',
  navBrandKit: 'Brand Kit',
  navExportHistory: 'Export History',
  navUsageCredits: 'Usage & Credits',
  navSettings: 'Settings',
  navHelpSupport: 'Help & Support',
  navAdminPanel: 'Admin Panel',
  searchPlaceholder: 'Search projects, videos… (filters My Projects)',
  upgradePlan: 'Upgrade Plan',
  accountSettings: 'Account settings',
  signIn: 'Sign in',
  register: 'Register',
  guestUser: 'Guest User',
  themeToggleLight: 'Switch to light theme',
  themeToggleDark: 'Switch to dark theme',
  languageToggle: 'Switch language',
  save: 'Save',
  cancel: 'Cancel',
  delete: 'Delete',
  remove: 'Remove',
  back: 'Back',
  loading: 'Loading…',
  ready: 'Ready',
  processing: 'Processing',
  queued: 'Queued',
  failed: 'Failed',
  cancelled: 'Cancelled',
  download: 'Download',
  downloadAll: 'Download all',
  createJob: 'Create job',
  view: 'View',
  copy: 'Copy',
  copied: 'Copied',
  retry: 'Retry',
  search: 'Search',
  upload: 'Upload',
  close: 'Close',
  edit: 'Edit',
  favourite: 'Favourite',
  dashboardTitle: 'Dashboard',
  dashboardSubtitle: 'Your clips, jobs and what is working best.',
  statJobs: 'Total jobs',
  statClips: 'Clips ready',
  statStorage: 'Storage used',
  statFavourites: 'Favourites',
  recentJobs: 'Recent jobs',
  topClips: 'Top clips',
  whatWorksBest: 'What works best',
  noJobsYet: 'No jobs yet',
  createFirstJob: 'Create your first job',
  mostViralClip: 'Most viral clip',
  jobsTitle: 'My Projects',
  jobsSubtitle: 'Every job you created, newest first.',
  searchJobs: 'Search jobs…',
  statusFilter: 'Status',
  allStatuses: 'All statuses',
  noJobsFound: 'No jobs found.',
  showingJobs: 'Showing jobs',
  newJobTitle: 'New Job',
  newJobSubtitle: 'Upload a video or paste a link, pick your style, and the engine cuts the clips.',
  sourceVideo: 'Source video',
  uploadVideo: 'Upload a video',
  videoLink: 'Video link',
  platform: 'Platform',
  aspectRatio: 'Aspect ratio',
  captionStyle: 'Caption style',
  captionPosition: 'Caption position',
  clipDuration: 'Clip duration',
  clipCount: 'Clip count',
  jobType: 'Job type',
  campaignRequirements: 'Campaign requirements',
  notes: 'Notes',
  createJobBtn: 'Create job',
  bulkJobs: 'Bulk jobs',
  chooseFile: 'Choose a file',
  pasteLink: 'Paste a link',
  wizardStep1: 'Step 1 — Choose your video',
  wizardStep2: 'Step 2 — Style your clips',
  wizardStep3: 'Step 3 — Process',
  chooseSource: 'Choose your source',
  chooseStyle: 'Choose a style',
  processTitle: 'Process your clips',
  libraryTitle: 'Video Library',
  librarySubtitle: 'Every clip the engine has made for you.',
  searchLibrary: 'Search library…',
  favouritesOnly: 'Favourites only',
  noClipsYet: 'No clips yet.',
  brandKitTitle: 'Brand Kit',
  brandKitSubtitle: 'Your intro, outro and logo — stitched onto your clips.',
  introVideo: 'Intro video',
  outroVideo: 'Outro video',
  logoImage: 'Logo',
  livePreview: 'Live preview',
  noAssetYet: 'No asset uploaded yet.',
  captionsTitle: 'Captions Studio',
  captionsSubtitle: 'Preview caption styles on a sample clip.',
  sampleText: 'Sample text',
  settingsTitle: 'Settings',
  settingsSubtitle: 'Manage your account settings.',
  tabProfile: 'Profile',
  tabSecurity: 'Security',
  tabNotifications: 'Notifications',
  tabPreferences: 'Preferences',
  tabStorage: 'Storage',
  tabBilling: 'Billing',
  tabCloudStorage: 'Cloud Storage',
  appearance: 'Appearance',
  themeLabel: 'Theme',
  languageLabel: 'Language',
  darkTheme: 'Dark',
  lightTheme: 'Light',
  english: 'English',
  romanUrdu: 'Roman Urdu',
  saveChanges: 'Save Changes',
  cloudStorageDesc:
    'Store new clips, thumbnails and sources in your own S3-compatible bucket (Cloudflare R2, AWS S3, or a custom endpoint) so they survive server restarts. Your keys are stored encrypted and never shown again.',
  cloudProvider: 'Provider',
  cloudEndpoint: 'Endpoint URL',
  cloudBucket: 'Bucket name',
  cloudRegion: 'Region',
  cloudAccessKey: 'Access key ID',
  cloudSecretKey: 'Secret access key',
  cloudEnabled: 'Use cloud storage for new files',
  testConnection: 'Test connection',
  testingConnection: 'Testing…',
  connectionOk: 'Connected — write, read and delete all worked.',
  connectionFailed: 'Connection failed',
  secretSaved: 'Secret saved (hidden — enter a new one to change it)',
  clipsReady: 'clips ready',
  jobDetails: 'Job details',
  welcomeBack: 'Welcome back',
  statProjects: 'Total Projects',
  statProcessing: 'Processing',
  recentProjects: 'Recent projects',
  gettingStarted: 'Getting started',
  recentExports: 'Recent exports',
  quickActions: 'Quick actions',
  recentActivity: 'Recent activity',
  viewAll: 'View All',
  noProjectsYet: 'No projects yet',
}

/** Roman Urdu (Latin script). Keys not listed here fall back to English. */
const UR: Partial<Record<TranslationKey, string>> = {
  navDashboard: 'Dashboard',
  navMyProjects: 'Mere Projects',
  navVideoLibrary: 'Video Library',
  navAiClipper: 'AI Clipper',
  navMyJobs: 'Meri Jobs',
  navStudioEditor: 'Studio Editor',
  navCaptionsStudio: 'Captions Studio',
  navBrandKit: 'Brand Kit',
  navExportHistory: 'Export History',
  navUsageCredits: 'Usage aur Credits',
  navSettings: 'Settings',
  navHelpSupport: 'Madad aur Support',
  navAdminPanel: 'Admin Panel',
  searchPlaceholder: 'Projects, videos talaash karein… (Mere Projects filter karta hai)',
  upgradePlan: 'Plan Upgrade karein',
  accountSettings: 'Account settings',
  signIn: 'Sign in karein',
  register: 'Register karein',
  guestUser: 'Mehman',
  themeToggleLight: 'Light theme karein',
  themeToggleDark: 'Dark theme karein',
  languageToggle: 'Zubaan badlein',
  save: 'Save karein',
  cancel: 'Mansookh karein',
  delete: 'Delete karein',
  remove: 'Hatayein',
  back: 'Wapas',
  loading: 'Load ho raha hai…',
  ready: 'Tayyar',
  processing: 'Ban rahi hai',
  queued: 'Qataar mein',
  failed: 'Nakaam',
  cancelled: 'Mansookh',
  download: 'Download karein',
  downloadAll: 'Sab download karein',
  createJob: 'Job banayein',
  view: 'Dekhein',
  copy: 'Copy karein',
  copied: 'Copy ho gaya',
  retry: 'Dobara koshish karein',
  search: 'Talaash karein',
  upload: 'Upload karein',
  close: 'Band karein',
  edit: 'Tabdeel karein',
  favourite: 'Pasandeeda',
  dashboardTitle: 'Dashboard',
  dashboardSubtitle: 'Aap ki clips, jobs aur jo behtar kaam kar raha hai.',
  statJobs: 'Kul jobs',
  statClips: 'Tayyar clips',
  statStorage: 'Storage istemal',
  statFavourites: 'Pasandeeda',
  recentJobs: 'Haal ki jobs',
  topClips: 'Behtareen clips',
  whatWorksBest: 'Kya behtar kaam karta hai',
  noJobsYet: 'Abhi koi job nahi',
  createFirstJob: 'Apni pehli job banayein',
  mostViralClip: 'Sab se viral clip',
  jobsTitle: 'Mere Projects',
  jobsSubtitle: 'Aap ki har job, nayi pehle.',
  searchJobs: 'Jobs talaash karein…',
  statusFilter: 'Status',
  allStatuses: 'Tamam statuses',
  noJobsFound: 'Koi job nahi mili.',
  showingJobs: 'Jobs dikhayi ja rahi hain',
  newJobTitle: 'Nayi Job',
  newJobSubtitle: 'Video upload karein ya link lagayein, style chunein, engine clips bana dega.',
  sourceVideo: 'Source video',
  uploadVideo: 'Video upload karein',
  videoLink: 'Video ka link',
  platform: 'Platform',
  aspectRatio: 'Video size',
  captionStyle: 'Caption style',
  captionPosition: 'Caption ki jagah',
  clipDuration: 'Clip ki muddat',
  clipCount: 'Clips ki tadaad',
  jobType: 'Job ki qism',
  campaignRequirements: 'Campaign ki zarooratein',
  notes: 'Notes',
  createJobBtn: 'Job banayein',
  bulkJobs: 'Bulk jobs',
  chooseFile: 'File chunein',
  pasteLink: 'Link lagayein',
  wizardStep1: 'Step 1 — Apni video chunein',
  wizardStep2: 'Step 2 — Clips ka style chunein',
  wizardStep3: 'Step 3 — Process karein',
  chooseSource: 'Source chunein',
  chooseStyle: 'Style chunein',
  processTitle: 'Apni clips process karein',
  libraryTitle: 'Video Library',
  librarySubtitle: 'Engine ne aap ke liye har clip banayi hai.',
  searchLibrary: 'Library talaash karein…',
  favouritesOnly: 'Sirf pasandeeda',
  noClipsYet: 'Abhi koi clip nahi.',
  brandKitTitle: 'Brand Kit',
  brandKitSubtitle: 'Aap ka intro, outro aur logo — clips par lag jayein ge.',
  introVideo: 'Intro video',
  outroVideo: 'Outro video',
  logoImage: 'Logo',
  livePreview: 'Live preview',
  noAssetYet: 'Abhi koi file upload nahi hui.',
  captionsTitle: 'Captions Studio',
  captionsSubtitle: 'Namuna clip par caption styles dekhein.',
  sampleText: 'Namuna text',
  settingsTitle: 'Settings',
  settingsSubtitle: 'Apni account settings sambhalein.',
  tabProfile: 'Profile',
  tabSecurity: 'Security',
  tabNotifications: 'Notifications',
  tabPreferences: 'Preferences',
  tabStorage: 'Storage',
  tabBilling: 'Billing',
  tabCloudStorage: 'Cloud Storage',
  appearance: 'Shakal',
  themeLabel: 'Theme',
  languageLabel: 'Zubaan',
  darkTheme: 'Dark',
  lightTheme: 'Light',
  english: 'English',
  romanUrdu: 'Roman Urdu',
  saveChanges: 'Tabdeeliyan save karein',
  cloudStorageDesc:
    'Nayi clips, thumbnails aur sources apne S3-compatible bucket (Cloudflare R2, AWS S3, ya custom endpoint) mein rakhein taake server restart par bhi mehfooz rahein. Aap ki keys encrypted save hoti hain aur dobara kabhi dikhayi nahi deti.',
  cloudProvider: 'Provider',
  cloudEndpoint: 'Endpoint URL',
  cloudBucket: 'Bucket ka naam',
  cloudRegion: 'Region',
  cloudAccessKey: 'Access key ID',
  cloudSecretKey: 'Secret access key',
  cloudEnabled: 'Nayi files ke liye cloud storage istemal karein',
  testConnection: 'Connection test karein',
  testingConnection: 'Test ho raha hai…',
  connectionOk: 'Connect ho gaya — write, read aur delete sab kaam kar gaye.',
  connectionFailed: 'Connection nakaam',
  secretSaved: 'Secret save hai (chhupa hua — badalne ke liye naya likhein)',
  clipsReady: 'clips tayyar hain',
  jobDetails: 'Job ki tafseel',
  welcomeBack: 'Wapas khush aamdeed',
  statProjects: 'Kul Projects',
  statProcessing: 'Ban rahi hai',
  recentProjects: 'Haal ke projects',
  gettingStarted: 'Shuru karein',
  recentExports: 'Haal ke exports',
  quickActions: 'Jaldi actions',
  recentActivity: 'Haal ki activity',
  viewAll: 'Sab dekhein',
  noProjectsYet: 'Abhi koi project nahi',
}

/**
 * Translate a key. Unknown language or a key missing from the Urdu
 * map falls back to English — a missing translation is never a blank
 * label. Video titles, captions, transcripts and job notes are never
 * passed through here.
 */
export function translate(key: TranslationKey, language: Language): string {
  if (language === 'ur') {
    return UR[key] ?? EN[key]
  }
  return EN[key]
}

export const LANGUAGES: { id: Language; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'ur', label: 'Roman Urdu' },
]

export const THEMES: { id: Theme; labelKey: TranslationKey }[] = [
  { id: 'dark', labelKey: 'darkTheme' },
  { id: 'light', labelKey: 'lightTheme' },
]
