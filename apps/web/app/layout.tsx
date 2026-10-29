import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ChainStatus, ChainSwitch, Nav } from './chrome';
import './globals.css';

export const metadata: Metadata = {
  title: 'fisika — stablecoin FX on Celo and BNB Chain',
  description: 'Best-execution stablecoin FX: naira, shilling, cedi, real, peso and dollars, routed across Mento, Uniswap, PancakeSwap and Textile on Celo and BNB Chain.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=Martian+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
      </head>
      <body>
        <div className="shell">
          <header className="top">
            <a className="wordmark" href="/">
              fisika<span>.</span>
            </a>
            <Nav />
            <ChainSwitch />
            <ChainStatus />
          </header>
          <main>{children}</main>
          <footer className="foot">
            Non-custodial: fisika never holds your funds. Rates are live from mainnet (Celo or BNB Chain, as selected) and include venue fees; network gas is shown separately.
          </footer>
        </div>
      </body>
    </html>
  );
}
