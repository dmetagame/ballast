import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

/// Scroll-driven beats on native scroll, and a teardown that leaves nothing behind.
///
/// **No smooth-scroll library.** Lenis was tried and removed. It holds its own scroll
/// position, so on a history traversal the browser restored `window.scrollY` and Lenis
/// animated straight back to the value it still held: going back from an in-page anchor left
/// the reader at 3362 instead of 0, while the same page without it restored correctly.
///
/// Two fixes were attempted and measured. Resyncing on `popstate` fixed back and broke the
/// anchor, because Chromium fires `popstate` for same-document fragment navigation too, which
/// froze the anchor's own scroll at 620px. Guarding that resync on `lenis.isScrolling` fixed
/// the anchor and broke back again, because the browser's restore scroll makes Lenis report
/// as scrolling. The two events are not distinguishable that way.
///
/// Back and forward are real navigation that real readers use. Scroll smoothing is a feel.
/// When the two conflict the navigation wins, so the library went and ScrollTrigger runs on
/// native scroll, which costs nothing here: scrub and pin work the same.
///
/// Everything below animates transform and opacity only. Nothing that carries a claim starts
/// hidden in CSS; initial states are set here, at runtime, and only once we know motion is
/// wanted. That ordering is why the caveats survive reduced motion and a JS failure alike.
export function initMotion() {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  // Reduced motion means no scrub timeline exists at all. The markup is already in its final
  // state, so there is nothing to reveal and nothing to undo.
  if (reduced.matches) return () => {};

  gsap.registerPlugin(ScrollTrigger);

  const ctx = gsap.context(() => {
    heroGauge();
    counters();
    drawdownRows();
    mechanismSteps();
  });

  // Layout settles after webfonts swap; stale trigger positions look like broken pinning.
  if (document.fonts?.ready) document.fonts.ready.then(() => ScrollTrigger.refresh());

  return () => {
    ctx.revert();
    ScrollTrigger.getAll().forEach((t) => t.kill());
  };
}

/// Beat 1. The user's own scroll performs the deleverage: the health marker drifts toward the
/// liquidation line, then gets pulled back. This is the product in one gesture.
function heroGauge() {
  const track = document.querySelector(".gauge-track");
  const marker = document.querySelector('[data-role="health-marker"]');
  const readout = document.querySelector('[data-role="health-value"]');
  if (!track || !marker || !readout) return;

  // The line sits at 18% and the marker rests at 62%, both as percentages of the track. The
  // gap is what the marker travels. Measured from layout rather than hardcoded, and
  // recomputed on refresh so it survives a resize.
  const travel = () => -0.44 * track.offsetWidth;

  // Health values the drift passes through. The floor is deliberately above 1.00: Ballast
  // acts before the seizure line, and showing it dipping below would misdescribe the product.
  const state = { health: 1.15 };
  const render = () => { readout.textContent = state.health.toFixed(2); };

  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: ".hero",
      start: "top top",
      end: "bottom top",
      scrub: 1,
      invalidateOnRefresh: true,
      onToggle: (self) => {
        marker.style.willChange = self.isActive ? "transform" : "";
      },
    },
  });

  tl.to(marker, { x: travel, ease: "expo.out", duration: 0.6 }, 0)
    .to(state, { health: 1.04, ease: "expo.out", duration: 0.6, onUpdate: render }, 0)
    .to(marker, { x: 0, ease: "expo.out", duration: 0.4 }, 0.6)
    .to(state, { health: 1.35, ease: "expo.out", duration: 0.4, onUpdate: render }, 0.6);
}

/// Beat 2. The stakes, counted up.
///
/// Three properties this has to hold, in order of how badly getting them wrong would matter:
///
/// 1. **The final frame is the measured value, exactly.** The tween interpolates a proxy and
///    formats it for display, but on completion the element is restored to the string the
///    build wrote from `monitor/data`. Landing on a rounded approximation would mean the page
///    published a wrong number, which is the one thing this project cannot do.
/// 2. **Screen readers never hear the tween.** The animated span is `aria-hidden`; a
///    visually-hidden sibling carries the real value and is never touched.
/// 3. **No JavaScript, no problem.** The measured value is already the element's text from the
///    server. This only ever replaces it temporarily, so a failure here leaves the number
///    correct rather than blank.
function counters() {
  const els = gsap.utils.toArray("[data-count]");

  els.forEach((el) => {
    const target = Number(el.dataset.count);
    if (!Number.isFinite(target)) return;

    // Captured before anything animates: this is the authored, measured string.
    const finalText = el.textContent;
    const format = formatterFor(finalText);
    const proxy = { value: 0 };

    gsap.to(proxy, {
      value: target,
      duration: 1.2,
      ease: "power3.out",
      scrollTrigger: { trigger: el, start: "top 85%", once: true },
      onStart() { el.style.willChange = "contents"; },
      onUpdate() { el.textContent = format(proxy.value); },
      onComplete() {
        el.textContent = finalText;
        el.style.willChange = "";
      },
    });
  });
}

/// Derives a display format from the authored string, so the tween looks like the thing it is
/// counting toward. Only used mid-flight; the exact value is restored on completion, so a
/// mismatch here is cosmetic rather than a published error.
function formatterFor(finalText) {
  const compact = finalText.match(/^\$([\d.]+)M$/);
  if (compact) {
    const decimals = (compact[1].split(".")[1] ?? "").length;
    return (v) => `$${(v / 1e6).toFixed(decimals)}M`;
  }
  return (v) => Math.round(v).toLocaleString("en-US");
}

/// Beat 3. Rows arrive as the drawdown deepens, and the -20% row lands last and stays
/// emphasised. That row is the argument, so it gets the final beat rather than the first.
function drawdownRows() {
  const rows = gsap.utils.toArray(".drawdown tbody tr");
  if (!rows.length) return;

  // Reveal in table order, but hold the key row back so it resolves last.
  const ordered = [...rows].sort((a, b) => a.classList.contains("is-key") - b.classList.contains("is-key"));

  gsap.from(ordered, {
    opacity: 0,
    y: 16,
    immediateRender: false,
    duration: 0.6,
    ease: "power3.out",
    stagger: 0.08,
    scrollTrigger: { trigger: ".drawdown", start: "top 70%", once: true },
    onStart() { ordered.forEach((r) => (r.style.willChange = "transform, opacity")); },
    onComplete() { ordered.forEach((r) => (r.style.willChange = "")); },
  });
}

/// Beat 4. The one place a pin is justified: five steps of a single atomic transaction,
/// highlighted one at a time. Pin distance is held to roughly one viewport height, because a
/// pin the reader cannot scroll out of quickly reads as broken rather than cinematic.
function mechanismSteps() {
  const steps = gsap.utils.toArray(".mechanism .steps li");
  if (!steps.length) return;

  gsap.set(steps, { opacity: 0.35 });

  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: ".mechanism",
      start: "center center",
      end: "+=100%",
      pin: true,
      scrub: 1,
      invalidateOnRefresh: true,
      anticipatePin: 1,
    },
  });

  steps.forEach((step, i) => {
    tl.to(step, { opacity: 1, duration: 0.5, ease: "power2.out" }, i * 0.5);
    if (i > 0) tl.to(steps[i - 1], { opacity: 0.35, duration: 0.5, ease: "power2.out" }, i * 0.5);
  });

  // Leave every step legible once the section is done, so a reader scrolling back sees the
  // whole mechanism rather than four dimmed boxes.
  tl.to(steps, { opacity: 1, duration: 0.4, ease: "power2.out" });
}
