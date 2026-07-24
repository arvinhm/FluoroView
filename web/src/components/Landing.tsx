import Hero from "./landing/Hero";
import StatsBand from "./landing/StatsBand";
import Features from "./landing/Features";
import Pipeline from "./landing/Pipeline";
import Footer from "./landing/Footer";

export default function Landing() {
  return (
    <div className="relative">
      <Hero />
      <StatsBand />
      <Features />
      <Pipeline />
      <Footer />
    </div>
  );
}
