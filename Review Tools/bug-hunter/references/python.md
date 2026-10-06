# Python regression checklist

Review the changed code for these semantic risks. Scripts cannot judge them. Do not report anything ruff, flake8, pylint, mypy, or pyright would already flag; focus on what this change breaks that was working before.

## asyncio races
- `asyncio.gather`, `create_task`, or `TaskGroup` over coroutines that read, modify and write the same dict, list, cache, global, or database row without an `asyncio.Lock` or atomic operation. A newly concurrent loop (sequential `await` changed to `gather`) is the usual trigger.
- A coroutine called without `await` (or a removed `await`: `REMOVED_AWAIT`) now returns a coroutine object instead of a result, and its exceptions are never seen.
- A `await` added between a check and the use it protects lets another task change state in between.
- Blocking work added to an async path only matters for the event loop if the call is new in this diff and not already offloaded; confirm before reporting.

## Duck-typing and return contracts
- When a function now returns a different type (dict to object, list to generator, `None` in a new case), look at every caller in the provided callers and diff: `data['id']` vs. `data.id`, `len(result)` on a generator, iterating twice over an iterator, truthiness of an empty result.
- A changed parameter default, order, or keyword name (`SIGNATURE_CHANGED`) silently shifts positional callers.
- A mutable default argument or shared module-level state *introduced by this change* that functions now mutate.
- A changed `__eq__`, `__hash__`, `__str__`, or dataclass field order/defaults affects every container or serializer using the type.

## Exception handling
- A new or widened `except` (`except Exception:`, bare `except:`) hides failures that used to propagate. Judge by context: does it catch `KeyboardInterrupt`/`asyncio.CancelledError` (bare `except` and `BaseException` do), and is the error logged or re-raised? Swallowing a database or I/O failure is a probable bug; swallowing a missing-key lookup may be intended.
- A removed `try/except/finally` or `with` block (`REMOVED_ERROR_HANDLING`, `REMOVED_CLEANUP`): trace what now escapes or stays open.
- `raise ... from None` or re-raising a different type changes what callers catch.

## Conditions and data
- `BEHAVIOR_CHANGE_PAIR` on a comparison, `and`/`or`, or `not`: find the boundary input where results differ.
- Truthiness changes (`if x:` vs. `if x is not None:`) differ for `0`, `''`, `[]`.
- Changed iteration or sorting order feeding code that assumes the old order; integer vs. true division; timezone-naive vs. aware datetimes.
