import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import "lenis/dist/lenis.css";

/// Smooth scroll and scroll-trigger wiring. No timelines yet; those arrive with the content.
///
/// Lenis rather than ScrollSmoother, and only one of the two: Lenis wraps native scroll, so
/// `position: sticky`, in-page anchors, find-in-page and back/forward scroll restoration keep
/// working. That matters more here than any capability ScrollSmoother adds, because this page
/// exists to be read and checked.
///
/// Returns a teardown so nothing leaks. A stranded ticker callback shows up later as degraded
/// scrolling, which reads as an unreliable site to exactly the person deciding whether to
/// trust this with a leveraged position.
export function initMotion() {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  // Reduced motion means Lenis is never constructed and no scrub timeline exists. Content is
  // already in its final state in the markup, so there is nothing to reveal.
  if (reduced.matches) return () => {};

  gsap.registerPlugin(ScrollTrigger);

  const lenis = new Lenis({ autoRaf: false, anchors: true });

  // One RAF loop. Driving Lenis from gsap's ticker keeps ScrollTrigger from reading a stale
  // scroll position and lagging a frame behind the wheel.
  const tick = (time) => lenis.raf(time * 1000);
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add(tick);
  gsap.ticker.lagSmoothing(0);

  return () => {
    gsap.ticker.remove(tick);
    lenis.destroy();
    ScrollTrigger.getAll().forEach((t) => t.kill());
  };
}
