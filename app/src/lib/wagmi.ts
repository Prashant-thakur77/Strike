import { http, createConfig } from "wagmi";
import { injected } from "wagmi/connectors/injected";
import { appChains } from "./chains";
import { readTransport } from "./rpc/client";

// Reads go through readTransport (the /api/rpc proxy when the build has it, else the public RPC); wallet writes go
// through the connected wallet's own provider, never through these.
const transport = (id: 46630 | 421614 | 4663) => readTransport(id, { batch: { wait: 16 } });

export const wagmiConfig = createConfig({
  chains: appChains,
  connectors: [injected()],
  transports: {
    46630: transport(46630),
    421614: transport(421614),
    4663: transport(4663),
    31337: http(undefined, { batch: { wait: 16 } }),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
