---
"hardhat-kms": patch
---

`kms history` now hides ids of 6 or 7 characters, such as a short Google Cloud project id, in user agents, `extra` fields, notes and the scope description. Before, any hidden value shorter than 8 characters was printed. A short id is hidden only as a whole word, so it is never cut out of a longer word. Principals still show scope ids as logged.
