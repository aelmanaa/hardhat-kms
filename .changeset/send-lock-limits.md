---
"hardhat-kms": patch
---

Fail a send that would wait on the send lock forever. A send from a KMS account and chain, made by code that runs inside a send from the same account and chain (for example another plugin's network hook during the fill), now fails at once instead of hanging. A send that waits 120 seconds while none of the account's earlier sends finish fails, and so does a send when 1024 sends from the account and chain already wait. In each case the error names the account and the chain, and nothing is signed or sent. The two limits are fixed in 1.0.
