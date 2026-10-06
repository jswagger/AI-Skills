# JavaScript / TypeScript regression checklist

Review the changed code for these semantic risks. Scripts cannot judge them. Do not report anything a compiler, `tsc`, or ESLint would already flag; focus on what this change breaks that was working before.

## Hooks and stale closures (React and similar)
- A changed `useEffect`/`useCallback`/`useMemo` body, or a changed dependency array, can capture values from an earlier render. Ask whether any variable the body reads is now missing from the array on purpose (and what happens if the value changes) or by accident.
- Removed cleanup in an effect (`return () => ...`) leaks listeners, timers or subscriptions across re-renders and unmounts. `REMOVED_CLEANUP` is the script signal; judge whether the setup is still present.
- A moved or newly conditional hook changes hook order between renders.

## State mutation vs. immutability
- In reducers, stores (Redux, Zustand, signals) and state setters, check that the changed code returns a new object or array. Assigning to a property of the existing state (`state.user.role = x`, `items.push(x)`, `arr.sort()` on state) skips re-renders and breaks memoization and equality checks.
- A shallow copy that now drops a nested update (spread of the outer object only) is the same class of bug.

## Promise and async control flow
- Rewriting a `.then()/.catch()` chain: confirm every branch still returns the promise, so errors reach the caller. A dropped `return` leaves a detached branch that swallows rejections.
- A removed `await` (`REMOVED_AWAIT`) changes the value's type, lets later code run before the work finishes, and moves errors outside the surrounding `try`.
- A function that changed between sync and async (`SIGNATURE_CHANGED`: "now async") breaks every caller that uses the return value directly. Check the callers provided.
- `Promise.all` replaced by sequential awaits (or the reverse) changes ordering and failure behavior.

## Contracts callers depend on
- Changed return shape (new `null`/`undefined` case, renamed field, array vs. single item) when callers destructure or index the result.
- Changed default value, optional parameter, or parameter order.
- Changed exports, event names, or string constants used elsewhere.

## Equality and conditions
- A `BEHAVIOR_CHANGE_PAIR` (`<` to `<=`, `&&` to `||`, a negation toggled): find the boundary input where old and new results differ, and check whether any caller or test depended on it.
- Truthiness vs. explicit comparison: `if (x)` vs. `x !== undefined` differ for `0`, `''`, `false`.
