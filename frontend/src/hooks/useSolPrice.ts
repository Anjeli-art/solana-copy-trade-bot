import { useEffect, useState } from "react";

const SOL_MINT = "So11111111111111111111111111111111111111112";

export function useSolPrice(walletSolPriceUsd: number) {
  const [fallbackSolPriceUsd, setFallbackSolPriceUsd] = useState(0);

  useEffect(() => {
    if (walletSolPriceUsd > 0) {
      return;
    }

    let isMounted = true;

    async function loadSolPrice() {
      try {
        const response = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`);
        const payload = (await response.json()) as Record<string, { usdPrice?: number }>;
        const price = payload[SOL_MINT]?.usdPrice;

        if (isMounted && typeof price === "number" && Number.isFinite(price) && price > 0) {
          setFallbackSolPriceUsd(price);
        }
      } catch {
        if (isMounted) {
          setFallbackSolPriceUsd(0);
        }
      }
    }

    loadSolPrice();

    return () => {
      isMounted = false;
    };
  }, [walletSolPriceUsd]);

  return walletSolPriceUsd || fallbackSolPriceUsd;
}
