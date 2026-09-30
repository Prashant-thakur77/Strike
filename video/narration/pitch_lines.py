import json
U = "U S D G"
# (slide id, caption tag, [(display, tts)]); an empty list = a short silent slide
SLIDES = [
 ("cover", "Strike", [
  ("Robinhood Chain put US stocks on-chain.", "Robinhood Chain put U S stocks on-chain."),
  ("Strike turns them into weekly options vaults, paid in USDG.", f"Strike turns them into weekly options vaults, paid in {U}.", [11])]),
 ("problem", "Problem", [
  ("Holding a stock token earns nothing extra.", None),
  ("Options on the chain are new, and none lets an AI agent make the weekly call inside rules the contract enforces.", None)]),
 ("traps", "Traps", [
  ("Stock tokens also have traps: a multiplier applied twice, prices frozen over the weekend, two layers of pause.", None),
  ("SafeStockFeed handles each one, and our monitor checks eight mainnet stock tokens, live.", "Safe Stock Feed handles each one, and our monitor checks eight mainnet stock tokens, live.", [37])]),
 ("whynow", "Why now", [
  ("Stylus makes solving the strike on-chain 3.3 times cheaper per proposal.", "Stylus makes solving the strike on-chain three point three times cheaper per proposal.", [101])]),
 ("agents", "Agents", [
  ("An AI agent picks each week's strike, but never touches the funds.", None),
  ("The mandate is fixed on-chain: a delta band, a premium floor, a maximum size.", None),
  ("Break it, and the agent's bond is slashed to depositors.", None),
  ("Agent one is ERC-8004 identity 114, with a public reputation.", "Agent one is E R C eighty oh four identity one hundred fourteen, with a public reputation.")]),
 ("epoch", "Each week", [
  ("Deposit TSLA, and each week the vault sells a covered call, for a premium in USDG.", f"Deposit Tesla, and each week the vault sells a covered call, for a premium in {U}.", [202]),
  ("Deposit USDG, and the put vault pays you to wait for a lower price.", f"Deposit {U}, and the put vault pays you to wait for a lower price.")]),
 ("demo", "The app", [
  ("It is live at strike-options.vercel.app.", "It's live at strike dash options dot vercel dot app.", [202])]),
 ("tryit", "Try it", [
  ("Test it without a wallet: the playground runs any proposal against a live mandate, and the proof page links every claim to its evidence.", None)]),
 ("traction", "Traction", [
  ("On testnet, a buyer agent paid 10.01 USDG of premium, and a reckless agent's 10 USDG slash was paid to depositors.", f"On testnet, a buyer agent paid ten point zero one {U} of premium, and a reckless agent's ten {U} slash was paid to depositors.")]),
 ("market", "Market", [
  ("Cboe's BXM index has covered-call data back to 1986, and our backtest shows 25 to 46% lower volatility than holding.", "C B O E's B X M index has covered-call data back to nineteen eighty-six, and our backtest shows twenty-five to forty-six percent lower volatility than holding.")]),
 ("users", "Users", []),
 ("competition", "Competition", [
  ("Stonkhouse and Archer Markets let traders pick strikes.", None),
  ("In Strike, a bonded agent proposes, and the contract checks.", None)]),
 ("business", "Business", [
  ("Strike takes ten percent of positive weekly net premium, half to the agent.", None),
  ("A losing week pays nothing.", None)]),
 ("safety", "Evidence", [
  ("Behind it are 802 tests and proofs: 432 Foundry tests, 9 properties proven with Halmos, and 99.1% line coverage.", "Behind it are eight hundred and two tests and proofs: four hundred thirty-two Foundry tests, nine properties proven with Halmos, and ninety-nine point one percent line coverage."),
  ("An internal review found 11 issues, one of them High, and all are fixed.", "An internal review found eleven issues, one of them high, and all are fixed.")]),
 ("roadmap", "Next", [
  ("Next come a capped mainnet vault, more tickers and put spreads.", None)]),
 ("ask", "The ask", [
  ("Strike: weekly options vaults on Robinhood Chain, with agents the contract holds to their mandate.", None)]),
]
if __name__ == "__main__":
    items = [{"id": s, "lines": [[x[0], x[1] or x[0], *x[2:]] for x in L]} for s, t, L in SLIDES if L]
    json.dump({"items": items}, open("pitch_job.json", "w"), indent=1)
    tot = 0
