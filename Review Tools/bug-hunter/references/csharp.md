# C# / .NET regression checklist

Review the changed code for these semantic risks. Scripts cannot judge them. Do not report anything the compiler, nullable analysis, or Roslyn analyzers would already flag; focus on what this change breaks that was working before.

## Concurrency and lifetime
- Find how the changed class is registered (`AddSingleton`, `AddScoped`, `AddTransient`, hosted service, static class). New or changed instance state in a singleton or static class is shared across requests and threads. Check for non-thread-safe collections (`Dictionary`, `List`, `HashSet`) written from concurrent paths, check-then-act sequences without a lock, and mutated fields.
- A scoped service captured by a singleton, or a `DbContext` used across threads or kept past its request.
- `async void`, `.Result`, or `.Wait()` introduced into a path that previously awaited (deadlock and exception-loss risk). A removed `await` (`REMOVED_AWAIT`) returns a `Task` where callers expect a value.

## Entity Framework
- A changed query is missing `.Include()`/`ThenInclude()`/projection that later code needs. Look at what is read inside any loop after the query: navigation properties touched per item mean one SQL query per item (N+1).
- `ToList()`/`AsEnumerable()` moved earlier moves filtering into memory; moved later changes when the query executes and which `DbContext` state it sees.
- A removed `AsNoTracking()` or `SaveChanges()`, or a changed transaction scope, alters what gets persisted.

## IDisposable and resources
- A new or changed class that owns streams, connections, timers or handles: does it implement the full dispose pattern, including disposing owned members and handling a second `Dispose` call?
- A removed `using`/`Dispose`/`finally` (`REMOVED_CLEANUP`, `REMOVED_ERROR_HANDLING`): trace the exception path to see whether the resource is now leaked.
- Event handlers subscribed (`+=`) with no matching unsubscribe keep objects alive.

## Contracts callers depend on
- Changed return type, `Task` vs. value, nullability, thrown exceptions, or default parameter values (`SIGNATURE_CHANGED`). Default values are baked into callers at compile time, so callers in other assemblies keep the old value until rebuilt.
- A changed public member, enum value (serialized or persisted values shift when reordered), or DTO property name used by JSON or database mapping.
- Changed `virtual`/`override` behavior affecting derived classes outside the diff.

## Conditions and data
- `BEHAVIOR_CHANGE_PAIR` on a comparison, boundary or flag: find the input where old and new results differ.
- LINQ ordering and `First`/`Single` changes (exception vs. default) and date/time or culture-sensitive parsing changes.
