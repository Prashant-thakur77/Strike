import { http, createConfig } from "wagmi";
import { injected } from "wagmi/connectors/injected";
import { appChains, RPC_OVERRIDES } from "./chains";

const transport = (url?: string) => http(url, { batch: { wait: 16 } });

export const wagmiConfig = createConfig({
  chains: appChains,
  connectors: [injected()],
  transports: {
    46630: transport(RPC_OVERRIDES[46630]),
    421614: transport(RPC_OVERRIDES[421614]),
    4663: transport(RPC_OVERRIDES[4663]),
    31337: transport(),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
