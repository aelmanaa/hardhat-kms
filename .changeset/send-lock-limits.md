---
"hardhat-kms": patch
---

Fail a send that would wait on the send lock forever. A send from a KMS account and chain, made by code that runs inside a send from the same account and chain (for example another plugin's network hook during the fill), now fails at once instead of hanging. This includes a send that nothing awaits, such as one started from a listener the hook triggers; await and catch it, or start it after the outer send returns, since an uncaught rejection ends the process. A send that waits 120 seconds while none of the account's earlier sends finish now fails; a slow RPC endpoint that holds up the broadcast ahead of it can cause this. A send also fails at once when 1024 sends from the account and chain already wait. In each case the error names the account and the chain, and nothing is signed or sent. The two limits are fixed in 1.0.
