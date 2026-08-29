/**
 * Every tunable value in the audit lives here.
 * Weights, vendor lists and copy are data, not logic - section 7 of the spec.
 *
 * The one field that is not in the spec is `renderSensitive`. It records
 * whether a check can be answered from raw HTML alone. It is the hinge that
 * section 5 turns on: see src/confidence.js.
 */

export const CHECKS = [
  // ---- Contact reachability - 40 -------------------------------------------
  {
    id: 'tel_link',
    group: 'contact',
    points: 12,
    renderSensitive: true,
    label: 'Click-to-call link',
    pass: 'Visitors can tap your number and be connected.',
    fail: 'Your phone number is not a tappable link.',
    cost: 'Over half of visitors arrive on a phone. A number they have to copy out and paste into the dialler is a number most of them never ring.'
  },
  {
    id: 'phone_in_header',
    group: 'contact',
    points: 8,
    renderSensitive: true,
    label: 'Phone number in the header',
    pass: 'Your number is visible at the top of the page.',
    fail: 'No phone number found near the top of the page.',
    cost: 'A ready-to-buy visitor should never have to hunt for your number. If it is not in the header they go back to the search results and ring whoever put it there.'
  },
  {
    id: 'email_or_contact_link',
    group: 'contact',
    points: 6,
    renderSensitive: true,
    label: 'Email or contact link',
    pass: 'There is a direct way to email or reach you.',
    fail: 'No email address or contact link found.',
    cost: 'Some people will not ring a stranger. With no written channel that enquiry simply does not happen.'
  },
  {
    id: 'contact_page_linked',
    group: 'contact',
    points: 6,
    renderSensitive: true,
    label: 'Contact page linked from the home page',
    pass: 'A contact page is linked from the home page.',
    fail: 'No link to a contact page found on the home page.',
    cost: 'Contact is the second most visited page on most small business sites. Not linking it from the home page hides the page people are actively looking for.'
  },
  {
    id: 'physical_address',
    group: 'contact',
    points: 4,
    renderSensitive: true,
    label: 'Physical address',
    pass: 'A physical address is published.',
    fail: 'No physical address found.',
    cost: 'An address is the cheapest trust signal you own, and it is what local search uses to decide whether you are a real nearby business.'
  },
  {
    id: 'tel_above_fold',
    group: 'contact',
    points: 4,
    renderSensitive: true,
    label: 'Click-to-call above the fold',
    pass: 'A call link appears before the visitor scrolls.',
    fail: 'No call link in the first screen of the page.',
    cost: 'Most visitors decide inside a few seconds. Anything below the fold is invisible to the ones who leave fastest, and they are the ones you are paying to attract.'
  },

  // ---- Capture mechanisms - 35 ---------------------------------------------
  {
    id: 'form_present',
    group: 'capture',
    points: 10,
    renderSensitive: true,
    label: 'Enquiry form',
    pass: 'There is a form on the page.',
    fail: 'No enquiry form found.',
    cost: 'A form is the only channel that works at 11pm on a Sunday. Without one, every out-of-hours visitor is lost rather than queued.'
  },
  {
    id: 'form_fields_lean',
    group: 'capture',
    points: 8,
    renderSensitive: true,
    dependsOn: 'form_present',
    label: 'Form is short (5 fields or fewer)',
    pass: 'Your form is short enough that people finish it.',
    fail: 'Your form asks for too many fields.',
    failNoDependency: 'There is no form on the page, so there is no short form to credit.',
    cost: 'Completion falls with every field added. Each question past the fifth is a share of your enquiries choosing to abandon instead.'
  },
  {
    id: 'chat_widget',
    group: 'capture',
    points: 10,
    renderSensitive: true,
    label: 'Live chat or messaging widget',
    pass: 'A chat widget is installed.',
    fail: 'No chat or messaging widget found.',
    cost: 'Chat catches the visitor who will not ring and will not fill in a form. It is the channel that recovers the enquiries the other two miss.'
  },
  {
    id: 'booking_link',
    group: 'capture',
    points: 7,
    renderSensitive: true,
    label: 'Booking or scheduling link',
    pass: 'Visitors can book a time themselves.',
    fail: 'No self-service booking link found.',
    cost: 'Without booking, every appointment costs you a round of phone tag. Self-booking converts interest while the visitor is still on the page.'
  },

  // ---- Conversion basics - 25 ----------------------------------------------
  {
    id: 'cta_text',
    group: 'conversion',
    points: 8,
    renderSensitive: true,
    label: 'Clear call to action',
    pass: 'There is a clear, action-led call to action.',
    fail: 'No clear call to action found.',
    cost: 'A page that does not ask for the next step does not get it. Visitors do not work out what to do; they leave.'
  },
  {
    id: 'viewport_meta',
    group: 'conversion',
    points: 6,
    renderSensitive: false,
    label: 'Mobile viewport set',
    pass: 'The page is set up to render properly on phones.',
    fail: 'No mobile viewport tag - the page will render desktop-sized on phones.',
    cost: 'Without this, phone visitors get a pinch-and-zoom desktop page. They do not zoom. They leave.'
  },
  {
    id: 'load_under_3s',
    group: 'conversion',
    points: 6,
    renderSensitive: false,
    label: 'Page responds in under 3 seconds',
    pass: 'The page responded quickly.',
    fail: 'The page took over 3 seconds to respond.',
    cost: 'Abandonment climbs sharply past three seconds, and it climbs hardest on mobile connections, which is where most of your traffic is.'
  },
  {
    id: 'https',
    group: 'conversion',
    points: 5,
    renderSensitive: false,
    label: 'Secure connection (HTTPS)',
    pass: 'The site is served over HTTPS.',
    fail: 'The site is not served securely over HTTPS.',
    cost: 'Browsers label the page Not Secure and warn on any form. Visitors take that warning at face value and do not submit.'
  }
];

export const GROUPS = {
  contact:    { label: 'Contact reachability', points: 40 },
  capture:    { label: 'Capture mechanisms',   points: 35 },
  conversion: { label: 'Conversion basics',    points: 25 }
};

export const BANDS = [
  { min: 80, label: 'Strong',     message: 'This site captures leads well. The remaining gaps are refinements, not leaks.' },
  { min: 60, label: 'Solid',      message: 'The basics are in place. The gaps below are the ones costing you enquiries.' },
  { min: 40, label: 'Needs work', message: 'Interested visitors are arriving and leaving without contacting you.' },
  { min: 0,  label: 'Poor',       message: 'This site is losing most of the enquiries it could be capturing.' }
];

/** Script src / inline markers that indicate a chat or messaging widget. */
export const CHAT_VENDORS = [
  { name: 'Intercom',        match: ['widget.intercom.io', 'js.intercomcdn.com', 'intercomSettings'] },
  { name: 'Drift',           match: ['js.driftt.com', 'drift.com/include'] },
  { name: 'Tawk.to',         match: ['embed.tawk.to', 'Tawk_API'] },
  { name: 'Crisp',           match: ['client.crisp.chat', 'CRISP_WEBSITE_ID'] },
  { name: 'Tidio',           match: ['code.tidio.co', 'widget-v4.tidiochat.com'] },
  { name: 'LiveChat',        match: ['cdn.livechatinc.com', '__lc.license'] },
  { name: 'Zendesk Chat',    match: ['static.zdassets.com/ekr/snippet.js', 'v2.zopim.com', 'zEmbed'] },
  { name: 'HubSpot Chat',    match: ['js.hs-scripts.com', 'js.usemessages.com', 'js-na1.hs-scripts.com'] },
  { name: 'Freshchat',       match: ['wchat.freshchat.com', 'fw-cdn.com'] },
  { name: 'Olark',           match: ['static.olark.com', 'olark.identify'] },
  { name: 'Chatra',          match: ['call.chatra.io', 'ChatraID'] },
  { name: 'Smartsupp',       match: ['smartsuppchat.com', '_smartsupp'] },
  { name: 'JivoChat',        match: ['code.jivosite.com', 'code.jivo.ru'] },
  { name: 'Gorgias Chat',    match: ['config.gorgias.chat'] },
  { name: 'Help Scout Beacon', match: ['beacon-v2.helpscout.net'] },
  { name: 'Podium',          match: ['connect.podium.com', 'podium.com/widget'] },
  { name: 'Birdeye',         match: ['birdeye.com/webchat', 'bd-widget'] },
  { name: 'LeadConnector',   match: ['widgets.leadconnectorhq.com', 'msgsndr.com/widget'] },
  { name: 'ManyChat',        match: ['mccdn.me', 'manychat.com/widget'] },
  { name: 'Facebook Messenger', match: ['fb-customerchat', 'sdk/xfbml.customerchat.js'] },
  { name: 'Userlike',        match: ['userlike-cdn-widgets', 'userlike.com/api'] },
  { name: 'LivePerson',      match: ['lptag.liveperson.net'] },
  { name: 'Kommunicate',     match: ['kommunicate.io/v2/kommunicate.app'] },
  { name: 'Chaport',         match: ['app.chaport.com/javascripts/insert.js'] },
  { name: 'Re:amaze',        match: ['cdn.reamaze.com'] },
  { name: 'Trengo',          match: ['static.widget.trengo.eu'] },
  { name: 'Landbot',         match: ['static.landbot.io'] },
  { name: 'Tars',            match: ['hellotars.com'] },
  { name: 'ApexChat',        match: ['apexchat.com/api', 'proto.apexchat.net'] },
  { name: 'Ngage',           match: ['secure.ngageics.com'] },
  { name: 'Verloop',         match: ['front.verloop.io'] },
  { name: 'Salesforce Chat', match: ['liveagent.salesforceliveagent.com', 'embeddedservice/'] },
  { name: 'Zoho SalesIQ',    match: ['salesiq.zoho.com'] },
  { name: 'Front Chat',      match: ['chat-assets.frontapp.com'] },
  { name: 'Pure Chat',       match: ['app.purechat.com'] },
  { name: 'Genesys',         match: ['apps.mypurecloud.com/widgets'] }
];

/** Hosts that indicate a self-service booking or scheduling link. */
export const BOOKING_HOSTS = [
  'calendly.com', 'cal.com', 'acuityscheduling.com', 'squarespacescheduling.com',
  'meetings.hubspot.com', 'meetings-na1.hubspot.com', 'hubspot.com/meetings',
  'youcanbook.me', 'youcanbookme.com', 'setmore.com', 'simplybook.me', 'simplybook.it',
  'bookeo.com', 'appointy.com', 'vagaro.com', 'mindbodyonline.com', 'fresha.com',
  'booksy.com', 'squareup.com/appointments', 'square.site/book', 'schedulicity.com',
  'timetap.com', '10to8.com', 'savvycal.com', 'tidycal.com', 'zcal.co', 'koalendar.com',
  'picktime.com', 'appointlet.com', 'oncehub.com', 'scheduleonce.com',
  'chilipiper.com', 'leadconnectorhq.com/widget/booking', 'msgsndr.com/widget/booking',
  'housecallpro.com/book', 'book.housecallpro.com', 'getjobber.com/request',
  'clienthub.getjobber.com', 'servicetitan.com/book', 'opentable.com', 'resy.com',
  'zohobookings.com', 'outlook.office365.com/owa/calendar',
  'outlook.office.com/bookdirect', 'bookwhen.com', 'calendarhero.com', 'doodle.com',
  'letsmeet.io', 'usemotion.com/meet', 'calendar.app.google',
  'calendar.google.com/calendar/appointments'
];

/**
 * Action-led phrases that count as a real call to action.
 * Deliberately excludes "learn more" and "read more" - they ask for a click,
 * not for an enquiry, and crediting them would inflate every score.
 */
export const CTA_VERBS = [
  'get a quote', 'get a free quote', 'free quote', 'request a quote', 'request quote',
  'get quote', 'get pricing', 'see pricing', 'get an estimate', 'free estimate',
  'request an estimate', 'book now', 'book online', 'book a call', 'book a demo',
  'book an appointment', 'book appointment', 'make an appointment', 'schedule a call',
  'schedule now', 'schedule an appointment', 'schedule a consultation', 'request a demo',
  'request demo', 'free consultation', 'book a consultation', 'get started',
  'start now', 'get in touch', 'contact us', 'contact me', 'talk to us', 'talk to an expert',
  'speak to us', 'speak with', 'message us', 'enquire now', 'enquire today', 'inquire now',
  'send enquiry', 'send inquiry', 'make an enquiry', 'request info', 'request information',
  'call now', 'call us', 'call today', 'call for a quote', 'get a callback',
  'request a callback', 'apply now', 'sign up', 'get help', 'hire us', 'work with us',
  'lets talk', 'reserve now', 'request service', 'request a service',
  'order now', 'buy now', 'shop now', 'claim your', 'claim my', 'get my free',
  'get your free', 'start your free', 'try for free', 'join now', 'subscribe',
  // Software and services phrasing. Missing these read as "no call to
  // action" on pages whose entire header is calls to action.
  'contact sales', 'talk to sales', 'speak to sales', 'contact a specialist',
  'start free trial', 'start a free trial', 'start your free trial', 'free trial',
  'start free', 'try it free', 'try free', 'get a demo', 'see a demo', 'view demo',
  'watch a demo', 'schedule a demo', 'see it in action', 'get a free trial',
  'book a table', 'order online', 'add to basket', 'add to cart', 'checkout',
  'get a free', 'request access', 'get access', 'download the', 'get the guide',
  'estimate', 'find a time', 'arrange a visit', 'book a visit', 'book a survey',
  'get a survey', 'ask a question', 'send us a message', 'leave a message',
  'whatsapp us', 'text us', 'email us', 'chat to us', 'chat with us'
];

/**
 * Markers that a page is a client-rendered shell. Presence alone proves
 * nothing - Next.js and Wix both server-render - so confidence.js treats
 * these as evidence weighed against how much real content came back, never
 * as a verdict on their own.
 */
export const SPA_MARKERS = [
  { name: 'React',        match: ['data-reactroot', 'react-dom', '_reactListening'] },
  { name: 'Next.js',      match: ['__NEXT_DATA__', '/_next/static'] },
  { name: 'Nuxt',         match: ['__NUXT__', '/_nuxt/'] },
  { name: 'Gatsby',       match: ['___gatsby', 'gatsby-chunk-mapping'] },
  { name: 'Angular',      match: ['<app-root', 'ng-version='] },
  { name: 'Vue',          match: ['data-v-app', 'id="q-app"'] },
  { name: 'SvelteKit',    match: ['__sveltekit_', 'data-sveltekit'] },
  { name: 'Wix',          match: ['wix-warmup-data', 'static.parastorage.com', 'wixstatic.com'] },
  { name: 'Squarespace',  match: ['static1.squarespace.com', 'SQUARESPACE_CONTEXT'] },
  { name: 'Webflow',      match: ['data-wf-page', 'assets.website-files.com'] },
  { name: 'Duda',         match: ['dudaone', 'irp.cdn-website.com'] },
  { name: 'GoDaddy',      match: ['img1.wsimg.com'] },
  { name: 'Remix',        match: ['__remixContext'] }
];

/**
 * The report is rendered in five sections, in this order:
 *
 *   contact     every contact-reachability check, pass or fail
 *   capture     every capture-mechanism check
 *   conversion  every conversion-basics check
 *   costs       what each failure is costing, in plain language
 *   fixes       the prioritised fix list, with the actual instructions
 *
 * The first three name every issue on the site - nothing is hidden about
 * WHAT is wrong. The last two are the analysis and the answers, and they are
 * blurred behind the call. Two sections of five.
 *
 * Set `enabled: false` to unlock everything, or edit `locked_sections` to
 * move the line. Nothing else needs to change.
 */
export const GATE = {
  enabled: true,
  locked_sections: ['costs', 'fixes']
};

export const BRAND = {
  name: 'Flashback',
  color: '#0071e3',   // matches --blue in public/index.html
  cta_text: 'Book a 30 minute call',
  cta_url: 'https://calendly.com/caydenrealchern/30min'
};

/**
 * Where this tool lives. Netlify sets `URL` to the site's primary address on
 * every build and every function invocation, so this is correct in production
 * with no configuration. `SITE_URL` overrides it if you ever need to.
 */
export const SITE_URL = (process.env.SITE_URL || process.env.URL || '').replace(/\/+$/, '');

/**
 * An optional contact for the user agent. Leave it unset.
 *
 * A personal address here ends up in the server log of every site scanned,
 * and those logs get harvested. If you ever want one, make it a role address
 * on a domain you control - never a personal inbox.
 */
export const CONTACT = process.env.AUDIT_CONTACT || '';

/**
 * The user agent every site you scan will see in its logs.
 *
 * It names the tool and links somewhere real, which is how a webmaster who
 * sees it in their log can find out what it was and how to reach you. That
 * is the Googlebot pattern - `+http://www.google.com/bot.html`, a URL rather
 * than an address - and it is the right one: a URL can be changed, cannot be
 * spammed, and does not put a personal inbox in a stranger's logs.
 *
 * When the site URL is not known - locally, or from the CLI - the link is
 * omitted rather than replaced with a placeholder. A made-up address in this
 * string is worse than no address: it reads as a scraper covering its tracks.
 */
export const USER_AGENT = `FlashbackLeadAudit/1.0 (${[
  SITE_URL ? `+${SITE_URL}` : null,
  'one page per request',
  CONTACT ? `contact ${CONTACT}` : null
].filter(Boolean).join('; ')})`;

export const FETCH = {
  timeout_ms: 6000,
  slow_threshold_ms: 3000,
  max_bytes: 3000000,
  user_agent: USER_AGENT,
  max_redirects: 5
};

/**
 * Rate limits. See src/ratelimit.js for how the three layers fit together.
 *
 * `global_requests` is the wallet guard: the most scans the whole site will
 * run in one window, across every lambda. Set it high enough that a good day
 * is never turned away and low enough that a bad one cannot run up a bill.
 * 240/min is roughly 14,000 an hour, which is far more traffic than a
 * LinkedIn post produces and far less than an abuser wants.
 */
export const RATE_LIMIT = {
  requests: 8,               // per IP, per window
  window_ms: 60000,
  instance_requests: 120,    // per warm lambda, enforced with or without a store
  global_requests: 240       // site-wide, needs the shared store
};

export const TOTAL_POINTS = CHECKS.reduce((n, c) => n + c.points, 0);

/**
 * Third-party form embeds. A site can have a perfectly good enquiry form and
 * no <form> tag anywhere in its HTML, because the form lives in an iframe or
 * is injected by a vendor script. Missing these is a false negative on a real
 * feature, which section 8 calls a blocking bug.
 */
export const FORM_EMBEDS = [
  { name: 'Typeform',      match: ['form.typeform.com', 'embed.typeform.com', 'data-tf-live', 'data-tf-widget'] },
  { name: 'Jotform',       match: ['form.jotform.com', 'jotform.com/jsform', 'js.jotform.com'] },
  { name: 'HubSpot Forms', match: ['js.hsforms.net', 'hsforms.com', 'hbspt.forms.create'] },
  { name: 'Google Forms',  match: ['docs.google.com/forms'] },
  { name: 'Gravity Forms', match: ['gform_wrapper', 'gravityforms'] },
  { name: 'Contact Form 7',match: ['wpcf7', 'contact-form-7'] },
  { name: 'WPForms',       match: ['wpforms-form', 'wpforms-container'] },
  { name: 'Ninja Forms',   match: ['nf-form-cont', 'ninja-forms'] },
  { name: 'Formstack',     match: ['formstack.com/forms'] },
  { name: 'Wufoo',         match: ['wufoo.com/forms'] },
  { name: 'Paperform',     match: ['paperform.co'] },
  { name: 'Tally',         match: ['tally.so/embed', 'tally.so/r/'] },
  { name: 'Cognito Forms', match: ['cognitoforms.com'] },
  { name: 'Mailchimp',     match: ['list-manage.com/subscribe', 'mc-embedded-subscribe'] },
  { name: 'ActiveCampaign',match: ['activehosted.com/f/', 'activehosted.com/proc.php'] },
  { name: 'LeadConnector', match: ['leadconnectorhq.com/widget/form', 'msgsndr.com/widget/form'] },
  { name: 'Klaviyo',       match: ['klaviyo_form', 'static.klaviyo.com'] },
  { name: 'Marketo',       match: ['mktoForm', 'marketo.com/js/forms2'] },
  { name: 'Pardot',        match: ['go.pardot.com/l/'] },
  { name: 'Zoho Forms',    match: ['forms.zohopublic.com'] },
  { name: 'Fillout',       match: ['fillout.com/t/', 'server.fillout.com'] },
  { name: 'Elfsight',      match: ['elfsight.com/platform', 'elfsight-app'] },
  { name: 'Squarespace Form', match: ['sqs-block-form'] }
];

/** What to actually do about each failed check - the prioritised fix list. */
export const FIXES = {
  tel_link: 'Wrap your phone number in a tel: link so tapping it dials. One line of HTML: <a href="tel:+441234567890">01234 567890</a>.',
  phone_in_header: 'Put your phone number in the site header so it appears at the top of every page, not just the contact page.',
  email_or_contact_link: 'Publish an email address as a mailto link, or link a contact page from the main navigation.',
  contact_page_linked: 'Add a Contact link to the main navigation on the home page.',
  physical_address: 'Add your full postal address to the footer, and mark it up as schema.org PostalAddress so search engines read it too.',
  tel_above_fold: 'Move the call link into the first screen - header bar or hero section - so it is visible without scrolling.',
  form_present: 'Add a short enquiry form to the home page. Name, phone or email, and what they need is enough.',
  form_fields_lean: 'Cut the form back to five fields or fewer. Ask for what you need to make contact; ask the rest on the call.',
  chat_widget: 'Install a chat or messaging widget so visitors who will not ring can still start a conversation.',
  booking_link: 'Add a booking link so visitors can put time in your diary without a phone call.',
  cta_text: 'Give the page one clear action - "Get a free quote", "Book a call" - as a button, repeated at the top and bottom.',
  viewport_meta: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the page head.',
  load_under_3s: 'Compress images, remove unused scripts and enable caching. Start with the largest images - they are almost always the cause.',
  https: 'Install an SSL certificate and redirect all http traffic to https. Most hosts now provide this free.'
};
