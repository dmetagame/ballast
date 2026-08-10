import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import "lenis/dist/lenis.css";

/// Smooth scroll, scroll-driven beats, and a teardown that leaves nothing behind.
///
/// Lenis rather than ScrollSmoother, and only one of the two: Lenis wraps native scroll, so
/// `position: sticky`, in-page anchors, find-in-page and back/forward scroll restoration keep
/// working. That matters more here than any capability ScrollSmoother adds, because this page
/// exists to be read and checked.
///
/// Everything below animates transform and opacity only. Nothing that carries a claim starts
/// hidden in CSS; initial states are set here, at runtime, and only once we know motion is
/// wanted. That ordering is why the caveats survive reduced motion and a JS failure alike.
export function initMotion() {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  // Reduced motion means Lenis is never constructed and no scrub timeline exists. The markup
  // is already in its final state, so there is nothing to reveal and nothing to undo.
  if (reduced.matches) return () => {};

  gsap.registerPlugin(ScrollTrigger);

  const lenis = new Lenis({ autoRaf: false, anchors: true });

  // One RAF loop. Driving Lenis from gsap's ticker keeps ScrollTrigger from reading a stale
  // scroll position and lagging a frame behind the wheel.
  const tick = (time) => lenis.raf(time * 1000);
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add(tick);
  gsap.ticker.lagSmoothing(0);

  const ctx = gsap.context(() => {
    heroGauge();
    drawdownRows();
    mechanismSteps();
  });

  // Layout settles after webfonts swap; stale trigger positions look like broken pinning.
  if (document.fonts?.ready) document.fonts.ready.then(() => ScrollTrigger.refresh());

  return () => {
    ctx.revert();
    gsap.ticker.remove(tick);
    lenis.destroy();
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
