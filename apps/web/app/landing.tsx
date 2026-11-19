'use client';
import { Lock, SignIn } from './session';

const FEATURES: { title: string; body: string; href: string }[] = [
  { title: 'Live FX rates', body: 'The best stablecoin rate for each currency pair on Celo and BNB Chain, at three order sizes, routed across every venue.', href: '/' },
  { title: 'Arbitrage engine', body: 'Finds loops that end with more dollars than they started with, re-quotes each leg live and trades within hard risk limits.', href: '/arb' },
  { title: 'Meme desk', body: 'Solana memecoin desk with rug checks, a daily loss cap, trailing take-profit and instant exits on liquidity pulls.', href: '/agent' },
  { title: 'Agent API', body: 'Quotes and ready-to-sign swaps for other agents over HTTP, paid per call in USDC with x402. ERC-8004 identity on Celo.', href: '/agents' },
  { title: 'Trade receipts', body: 'Every swap with the rate it was quoted and the rate it got, checked against the chain and hashed for independent verification.', href: '/trades' },
  { title: 'Agent console', body: 'Switch the agent on and off per chain, fund it, withdraw to your own wallet and export the full trade history.', href: '/agent' },
];

export function Landing() {
  return (
    <>
      <section className="hero">
        <h1>An FX desk that runs itself</h1>
        <p className="lede">
          fisika is an agent-native stablecoin FX desk on Celo and BNB Chain: best-execution routing, an arbitrage engine, a Solana meme desk and a paid API for other agents. Access is by invitation while fisika is in private beta.
        </p>
      </section>
      <div className="features">
        {FEATURES.map((f) => (
          <a key={f.title} className="feature" href={f.href}>
            <span className="feature-lock"><Lock /> Sign in</span>
            <h2>{f.title}</h2>
            <p>{f.body}</p>
          </a>
        ))}
      </div>
      <SignIn title="Sign in to open fisika" />
    </>
  );
}
