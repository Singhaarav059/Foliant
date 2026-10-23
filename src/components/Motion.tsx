import { Fragment } from "react";

// Small, server-rendered motion pieces. All of them animate in CSS
// (src/app/globals.css), so the text is in the HTML and reads the same
// with scripts off or motion reduced.

// A headline whose words lift in one by one. The spaces stay text nodes, so
// textContent is the original string. Languages without spaces animate as one.
export function Words({ text }: { text: string }) {
  const words = text.split(" ");
  return (
    <span className="words">
      {words.map((w, i) => (
        <Fragment key={i}>
          <span style={{ "--i": i } as React.CSSProperties}>{w}</span>
          {i < words.length - 1 && " "}
        </Fragment>
      ))}
    </span>
  );
}

// Three sheets of paper, the top one with the logo's folded corner. They
// float, and fan apart as the hero scrolls away.
export function PaperStack() {
  const sheet =
    "absolute inset-0 rounded-[6px] border border-line bg-surface shadow-lift [animation:float_7s_var(--ease-in-out)_infinite]";
  return (
    <div aria-hidden className="fan relative mx-auto aspect-[3/4] w-[min(72vw,300px)] [perspective:1200px]">
      <div
        className={sheet}
        style={{ "--r": "-9deg", translate: "calc(-14px - var(--spread) * 60px) calc(10px + var(--spread) * 30px)", animationDelay: "-2s" } as React.CSSProperties}
      />
      <div
        className={sheet}
        style={{ "--r": "5deg", translate: "calc(12px + var(--spread) * 70px) calc(4px + var(--spread) * 14px)", animationDelay: "-4.5s" } as React.CSSProperties}
      />
      <div className={`${sheet} overflow-hidden p-[9%]`} style={{ "--r": "-1deg", translate: "0 calc(var(--spread) * -24px)" } as React.CSSProperties}>
        <span className="absolute end-0 top-0 h-[18%] w-[24%] rounded-es-[6px] bg-accent [clip-path:polygon(0_0,100%_100%,0_100%)] rtl:[clip-path:polygon(100%_0,100%_100%,0_100%)]" />
        <span className="absolute end-0 top-0 h-[18%] w-[24%] bg-bg [clip-path:polygon(0_0,100%_0,100%_100%)] rtl:[clip-path:polygon(0_0,100%_0,0_100%)]" />
        <span className="block h-[7%] w-[55%] rounded-sm bg-ink/85" />
        <span className="mt-[8%] block h-[3%] w-full rounded-sm bg-line-strong/70" />
        <span className="mt-[4%] block h-[3%] w-[92%] rounded-sm bg-line-strong/70" />
        <span className="mt-[4%] block h-[3%] w-[96%] rounded-sm bg-line-strong/70" />
        <span className="mt-[4%] block h-[3%] w-[70%] rounded-sm bg-line-strong/70" />
        <span className="mt-[10%] block aspect-[16/9] w-full rounded-sm bg-surface-2" />
        <span className="mt-[8%] block h-[3%] w-full rounded-sm bg-line-strong/70" />
        <span className="mt-[4%] block h-[3%] w-[84%] rounded-sm bg-line-strong/70" />
        <span className="absolute bottom-[7%] end-[9%] font-mono text-[10px] text-muted">01</span>
      </div>
    </div>
  );
}
