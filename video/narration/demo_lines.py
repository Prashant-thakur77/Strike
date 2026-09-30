import json
U = "U S D G"
# (id, start, end, [(display, tts)])  windows from docs/media/strike-demo.srt scene boundaries
SCENES = [
 ("d01", 0.000, 8.140, [
  ("Strike runs weekly options vaults for stock tokens on Robinhood Chain.", None, [303, 606]),
  ("Everything here is read from the testnet.", None)]),
 ("d02", 8.140, 17.645, [
  ("Stock tokens earn nothing on their own.", None),
  ("Options exist on the chain, but people run them by hand.", None),
  ("In Strike an AI agent runs the vault, and the contract enforces the rules.", "In Strike, an AI agent runs the vault, and the contract enforces the rules.")]),
 ("d03", 17.645, 28.848, [
  ("Stonkhouse and Archer Markets let traders pick strikes and trade them on an order book.", "Stonkhouse and Archer Markets let traders pick strikes, and trade them on an order book."),
  ("In Strike, a bonded agent proposes the strike, and the contract checks it before anything is sold.", None)]),
 ("d04", 28.848, 43.217, [
  ("The playground asks the deployed EpochManager about a proposal, with a read-only call.", "The playground asks the deployed Epoch Manager about a proposal, with a read-only call."),
  ("An honest 0.20-delta call is accepted.", "An honest zero point two delta call is accepted."),
  ("A reckless at-the-money put is rejected, DeltaOutOfBand, and a real one would cost the agent 10 USDG of its bond.", f"A reckless at-the-money put is rejected: Delta Out Of Band. A real one would cost the agent ten {U} of its bond.")]),
 ("d05", 43.217, 62.006, [
  ("This ran on Robinhood Chain testnet on September 29.", "This ran on Robinhood Chain testnet on September twenty-ninth."),
  ("The seller agent asked for a 0.20-delta TSLA call, and the contract solved the strike on-chain: $369.86, accepted.", "The seller agent asked for a zero point two delta Tesla call, and the contract solved the strike on-chain: three hundred sixty-nine dollars eighty-six. Accepted."),
  ("Then a reckless agent forced an at-the-money put.", None),
  ("The contract rejected it and slashed 10 USDG.", f"The contract rejected it, and slashed ten {U}."),
  ("Its bond went from 60 to 50.", "Its bond went from sixty to fifty.")]),
 ("d06", 62.006, 66.307, [
  ("Here is that rejection on Blockscout, with the 10 USDG leaving the bond.", f"Here is that rejection on Blockscout, with the ten {U} leaving the bond.")]),
 ("d07", 66.307, 73.177, [
  ("A buyer agent with a 15 USDG budget bought 4 calls.", f"A buyer agent with a fifteen {U} budget bought four calls."),
  ("The premium is the most it can lose.", None)]),
 ("d08", 73.177, 88.422, [
  ("This is the TSLA covered-call vault.", "This is the Tesla covered-call vault."),
  ("The buyer pays Black-Scholes fair value at the oracle price plus 0.5%, never below intrinsic value.", "The buyer pays Black-Scholes fair value, at the oracle price plus zero point five percent, never below intrinsic value."),
  ("The buyer profits above $372.36.", "The buyer profits above three hundred seventy-two dollars thirty-six."),
  ("At or below the strike, depositors keep the whole premium.", None)]),
 ("d09", 88.422, 102.303, [
  ("The backtest runs the rules over 403 weeks, 2019 to 2026.", "The backtest runs the rules over four hundred and three weeks, twenty nineteen to twenty twenty-six."),
  ("On NVDA, the covered call cuts volatility from 45.6% to 26.5%.", "On Nvidia, the covered call cuts volatility from forty-five point six to twenty-six point five percent."),
  ("Every stock trades upside for 25 to 46% lower volatility.", "Every stock trades upside for twenty-five to forty-six percent lower volatility.")]),
 ("d10", 102.303, 121.096, [
  ("Every agent posts a USDG bond.", f"Every agent posts a {U} bond."),
  ("Agent one is ERC-8004 identity 114: one accepted, one rejected, one strike, a 50 USDG bond.", f"Agent one is E R C eighty oh four identity one hundred fourteen: one accepted, one rejected, one strike, and a fifty {U} bond."),
  ("The rejection feed lists every slash.", None),
  ("And the market is open: any agent can register, bond USDG and run a vault, with no permission needed.", f"And the market is open: any agent can register, bond {U}, and run a vault, with no permission needed.")]),
 ("d11", 121.096, 130.823, [
  ("The Telegram bot reads the same contract logs.", None),
  ("It posts the rejection with the rule that was broken and the slash, and the sale of 4 calls.", "It posts the rejection, with the rule that was broken and the slash, and the sale of four calls.")]),
 ("d12", 130.823, 141.454, [
  ("The monitor gives every stock token on mainnet the verdict our contracts would.", None),
  ("NVDA's multiplier, 1.000775, is already in the price, so Strike never applies it.", "Nvidia's multiplier, one point zero zero zero, seven seven five, is already in the price, so Strike never applies it.")]),
 ("d13", 141.454, 154.568, [
  ("The proof page puts each claim next to its evidence.", None),
  ("Every deployed contract is verified on Blockscout.", None),
  ("There are 432 Foundry tests and 9 properties proven with Halmos.", "There are four hundred thirty-two Foundry tests, and nine properties proven with Halmos."),
  ("An internal review found 11 issues, and all are fixed.", "An internal review found eleven issues, and all are fixed.")]),
 ("d14", 154.568, 168.173, [
  ("In total there are 802 tests and proofs, including 9 fork tests on mainnet.", "In total there are eight hundred and two tests and proofs, including nine fork tests on mainnet."),
  ("Line coverage is 99.1%.", "Line coverage is ninety-nine point one percent."),
  ("The strike solver written for Stylus costs 6.5 times less gas than the Solidity one.", "The strike solver written for Stylus costs six point five times less gas than the Solidity one.")]),
 ("d15", 168.173, 174.533, [
  ("Strike: options on Robinhood Chain, run by agents that cannot break the rules.", None),
  ("Unaudited, and live on testnet.", None)]),
]
if __name__ == "__main__":
    items = [{"id": i, "lines": [[x[0], x[1] or x[0], *x[2:]] for x in L]} for i, a, b, L in SCENES]
    json.dump({"items": items}, open("demo_job.json", "w"), indent=1)
