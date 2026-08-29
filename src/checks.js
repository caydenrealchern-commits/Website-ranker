/**
 * The checks themselves.
 *
 * Each returns { status: 'pass' | 'fail', via, evidence } and nothing else.
 * Deciding whether a `fail` is safe to publish is not their job - that is
 * confidence.js, applied in audit.js. Keeping the two apart is what makes the
 * section 5 rule enforceable in one place instead of fourteen.
 *
 * `via` records where the finding came from, because the report is more
 * convincing when it can say *how* it knows:
 *   dom        - the rendered markup
 *   structured - JSON-LD or microdata
 *   embedded   - the page's own script payload
 *   transport  - the HTTP response itself
 */

import { CHAT_VENDORS, BOOKING_HOSTS, CTA_VERBS, FORM_EMBEDS, FETCH } from './config.js';
import { hasAddressShape, isPlausiblePhone, textFromMarkup } from './extract.js';

const pass = (via, evidence) => ({ status: 'pass', via, evidence });
const fail = (evidence) => ({ status: 'fail', evidence });

/** A tel: href anywhere in the source, including inside a script payload. */
const TEL_HREF = /["'\s(]tel:\s*(\+?[\d][\d\s().+-]{6,20})/i;
const TEL_HREF_G = /["'\s(]tel:\s*(\+?[\d][\d\s().+-]{6,20})/gi;
const MAILTO = /["'\s(]mailto:\s*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24})/i;

const CONTACT_HREF = /(^|\/)(contact|contact-us|contactus|get-in-touch|getintouch|enquir\w*|inquir\w*|reach-us|kontakt)(\/|\.|#|\?|$)/i;
const CONTACT_TEXT = /\b(contact|get in touch|enquir|inquir|reach us|talk to us|message us|book us)\b/i;

function matchVendor(haystack, list) {
  for (const vendor of list) {
    for (const needle of vendor.match) {
      if (haystack.includes(needle.toLowerCase())) return { name: vendor.name, needle };
    }
  }
  return null;
}

/** Absolute char offset of the first tel: link, or -1. */
function firstTelIndex(raw) {
  const m = TEL_HREF.exec(raw);
  return m ? m.index : -1;
}

function headerRegion(doc) {
  // Two views of "the top of the page": the semantic header, and the first
  // slice of body markup. Sites that use neither convention still get a fair
  // read from the slice.
  //
  // Both views are stripped of script, style and svg content first. Inline SVG
  // path data is full of numbers shaped exactly like phone numbers, and one
  // false match there produces a confidently wrong finding.
  const { $, raw, bodyStart, bodyLength } = doc;
  const sliceEnd = bodyStart + Math.max(3000, Math.floor(bodyLength * 0.15));
  const sliceText = textFromMarkup(raw.slice(bodyStart, sliceEnd));

  let semantic = '';
  $('header, [role="banner"], .header, #header, .site-header, .topbar, .top-bar, .navbar, nav').each((_, el) => {
    if (semantic.length >= 8000) return;
    const $clone = $(el).clone();
    $clone.find('script, style, svg, noscript').remove();
    semantic += ' ' + ($clone.text() || '');
  });

  return { sliceText, semantic, sliceEnd };
}

export function runChecks(doc, ctx) {
  const { raw, lowerRaw, visibleText, embeddedText, anchors, forms, facts, $ } = doc;
  const header = headerRegion(doc);
  const results = {};

  // ---------------------------------------------------------------- contact --
  const domTel = $('a[href^="tel:"]').length > 0;
  const rawTel = TEL_HREF.test(raw);

  results.tel_link = domTel
    ? pass('dom', `${$('a[href^="tel:"]').length} click-to-call link(s) in the page`)
    : rawTel
      // The link is in the page payload rather than the served markup. It will
      // render. Reporting this as a failure would be the exact false negative
      // section 5 exists to prevent.
      ? pass('embedded', 'a click-to-call link is present in the page payload')
      // Two different failures wearing one label. "Your number is not
      // tappable" is a lie if there is no number on the page at all, and that
      // sentence is the one that becomes the headline of the whole report.
      // Only the trustworthy set of numbers - visible text and structured
      // data - earns the sharper wording; numbers scraped out of script
      // payloads are too noisy to accuse someone with.
      : facts.phones.length
        ? {
            status: 'fail',
            evidence: `${facts.phones[0]} appears on the page, but it is not a tappable link`,
            failMessage: 'Your phone number is on the page but it is not a tappable link.'
          }
        : {
            status: 'fail',
            evidence: 'no phone number and no click-to-call link found',
            failMessage: 'There is no phone number on this page at all.',
            failCost: 'Over half of visitors arrive on a phone, and a large share of them would rather ring than type. With no number anywhere on the page, that whole group leaves without contacting you.'
          };

  const telIndex = firstTelIndex(raw);
  const telInHeaderSlice = telIndex >= 0 && telIndex < header.sliceEnd;
  const phoneInHeaderText =
    (header.semantic.match(/[+(]?\d[\d\s().-]{7,20}\d/g) || []).some(isPlausiblePhone) ||
    (header.sliceText.match(/[+(]?\d[\d\s().-]{7,20}\d/g) || []).some(isPlausiblePhone);

  results.phone_in_header = telInHeaderSlice
    ? pass('dom', 'a call link sits in the top section of the page')
    : phoneInHeaderText
      ? pass('dom', 'a phone number appears in the top section of the page')
      : fail('no phone number in the top section of the page');

  // Above the fold is a tighter slice than "the header region".
  const foldEnd = doc.bodyStart + Math.max(2000, Math.floor(doc.bodyLength * 0.08));
  results.tel_above_fold = telIndex >= 0 && telIndex < foldEnd
    ? pass('dom', 'a call link appears in the first screen of the page')
    : fail('no call link before the visitor has to scroll');

  const mailtoMatch = MAILTO.exec(raw);
  const contactLink = anchors.find(
    (a) => CONTACT_HREF.test(a.href) || CONTACT_TEXT.test(a.lower)
  );
  results.email_or_contact_link = mailtoMatch
    ? pass('dom', `mailto link to ${mailtoMatch[1]}`)
    : facts.emails.length
      ? pass('dom', `email address ${facts.emails[0]} published on the page`)
      : contactLink
        ? pass('dom', `a "${contactLink.text || contactLink.href}" link`)
        : facts.embeddedEmails.length
          ? pass('embedded', 'an email address is present in the page payload')
          : fail('no email address or contact link found');

  results.contact_page_linked = contactLink
    ? pass('dom', `links to ${contactLink.href}`)
    : /contact|get-in-touch|enquir|inquir/i.test(embeddedText.slice(0, 200000))
      ? pass('embedded', 'a contact route is present in the page payload')
      : fail('no contact page linked from the home page');

  const structuredAddress = facts.addresses.length > 0;
  results.physical_address = structuredAddress
    ? pass('structured', `address published as structured data: ${facts.addresses[0].slice(0, 120)}`)
    : hasAddressShape(visibleText)
      ? pass('dom', 'a postal address appears in the page text')
      : hasAddressShape(embeddedText)
        ? pass('embedded', 'a postal address is present in the page payload')
        : fail('no physical address found');

  // ---------------------------------------------------------------- capture --
  const realForms = forms.filter((f) => !f.isSearch && f.fieldCount > 0);
  const formEmbed = matchVendor(lowerRaw, FORM_EMBEDS);

  results.form_present = realForms.length
    ? pass('dom', `${realForms.length} form(s) on the page`)
    : formEmbed
      ? pass('embedded', `an embedded ${formEmbed.name} form`)
      : fail('no enquiry form found');

  if (realForms.length) {
    const smallest = Math.min(...realForms.map((f) => f.fieldCount));
    results.form_fields_lean = smallest <= 5
      ? pass('dom', `shortest form asks for ${smallest} field(s)`)
      : fail(`shortest form asks for ${smallest} fields`);
  } else if (formEmbed) {
    // The form is real but lives inside a third-party embed, so its fields are
    // not ours to count. Unknown is the honest answer; guessing either way
    // would be inventing a finding.
    results.form_fields_lean = {
      status: 'unknown',
      via: 'embedded',
      evidence: `the form is embedded from ${formEmbed.name}, so we cannot count its fields from here`
    };
  } else {
    results.form_fields_lean = fail('no form on the page to evaluate');
  }

  const chat = matchVendor(lowerRaw, CHAT_VENDORS);
  results.chat_widget = chat
    ? pass('dom', `${chat.name} chat widget installed`)
    // Worded precisely. Chat is nearly always installed as a snippet in the
    // page source, which is what we look for. A widget that a site's own
    // application code injects after load leaves no trace in the source, so
    // the honest claim is about the source, not about the site.
    : fail('no chat widget snippet found in the page source');

  const bookingAnchor = anchors.find((a) =>
    BOOKING_HOSTS.some((host) => a.href.toLowerCase().includes(host))
  );
  const bookingInPayload = BOOKING_HOSTS.find((host) => lowerRaw.includes(host));
  results.booking_link = bookingAnchor
    ? pass('dom', `booking link to ${new URL(bookingAnchor.href, doc.finalUrl).hostname}`)
    : facts.bookingUrls.length
      ? pass('structured', 'a booking action is published as structured data')
      : bookingInPayload
        ? pass('embedded', `a ${bookingInPayload} booking link is present in the page payload`)
        : fail('no self-service booking link found');

  // ------------------------------------------------------------- conversion --
  const ctaCandidates = [];
  $('a, button, input[type="submit"], input[type="button"], [role="button"]').each((_, el) => {
    const $el = $(el).clone();
    // Buttons on modern marketing sites often wrap inline <style> and <svg>.
    // Left in, that text runs past the length cap and hides a real CTA.
    $el.find('script, style, svg, noscript').remove();
    const text = ($el.text() || $(el).attr('value') || $(el).attr('aria-label') || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (text && text.length <= 60) ctaCandidates.push(text);
  });
  const ctaHit = CTA_VERBS.find((verb) => ctaCandidates.some((text) => text.includes(verb)));
  results.cta_text = ctaHit
    ? pass('dom', `a "${ctaHit}" button or link`)
    : fail('no action-led call to action found on a button or link');

  const viewport = $('meta[name="viewport"]').attr('content') || '';
  results.viewport_meta = /width\s*=\s*device-width/i.test(viewport)
    ? pass('transport', 'viewport meta tag set to device width')
    : viewport
      ? fail(`viewport tag present but does not set device width ("${viewport.slice(0, 60)}")`)
      : fail('no mobile viewport meta tag');

  results.load_under_3s = ctx.elapsedMs < FETCH.slow_threshold_ms
    ? pass('transport', `responded in ${(ctx.elapsedMs / 1000).toFixed(1)}s`)
    : {
        status: 'fail',
        via: 'transport',
        evidence: ctx.truncated
          ? `still sending the page after ${(ctx.elapsedMs / 1000).toFixed(1)}s`
          : `took ${(ctx.elapsedMs / 1000).toFixed(1)}s to respond`
      };

  results.https = new URL(ctx.finalUrl).protocol === 'https:'
    ? pass('transport', 'served over HTTPS')
    : fail('served over plain HTTP');

  return results;
}

export { TEL_HREF_G };
