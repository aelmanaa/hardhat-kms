---
"hardhat-kms": patch
---

A send that would wait on the send lock forever now fails. A send from a KMS account and chain, made by code that runs inside a send from the same account and chain, such as another plugin's network hook during the fill, fails at once. Before, it hung. A send that waits 120 seconds while none of the account's earlier sends finish fails. A send also fails at once when 1024 sends from the account and chain already wait. In each case the error names the account and the chain, and nothing is signed or sent. The two limits are not configurable.

What should I do? A send that nothing awaits, such as one started from a listener the hook triggers, now rejects. Await and catch it, or start it after the outer send returns. An uncaught rejection ends the process.

Issue: [#120](https://github.com/aelmanaa/hardhat-kms/issues/120)
