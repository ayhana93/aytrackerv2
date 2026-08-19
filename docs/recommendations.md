# Recommendations

The loop from "a customer had an idea" to "it shipped". Settings → Recommendations.

---

## 1. Submission

```
Have an idea?

[ Title ]
[ Description ]

Category:  New Feature · Improvement · Bug / Problem · Integration
           Report / Analytics · Driver / Fleet · Other
Priority:  Nice to have · Important · Critical

[ SUBMIT ]
```

Requires `recommendations.create` — supervisor and above. Title 4–160 characters, description
10–4000, both trimmed and stripped of control characters.

---

## 2. Model

```
Recommendation
  organizationId, submittedByUserId,
  title, description, category, priority, status,
  adminNotes,            ← platform staff only, never returned to the customer
  duplicateOfId, roadmapItemId
```

```
SUBMITTED → UNDER_REVIEW → PLANNED → IN_DEVELOPMENT → RELEASED
     └────────────┴───────────┴──────► DECLINED / DUPLICATE
```

`RELEASED`, `DECLINED` and `DUPLICATE` are terminal. Reopening means a **new** recommendation
linked to the same roadmap item — which keeps the history of what a customer was told honest.
`assertStatusTransition` enforces the graph.

---

## 3. Visibility

A customer sees their own organization's recommendations and their statuses. They never see
another customer's, and never see `adminNotes`.

```ts
assertCanRead({ actorOrganizationId, recommendationOrganizationId, isPlatformAdmin });
```

Platform staff see everything — that is the point of a shared roadmap. The per-organization
scoping is what stops one customer learning what another is asking for, which for a B2B product
is competitively sensitive.

---

## 4. Platform review

Staff can search, filter, group by category and priority, change status, add notes, merge
duplicates, link roadmap items, and see which organizations requested what.

`assertCanMerge` refuses merging into a recommendation that is itself a duplicate, so chains
cannot form. Merging preserves the source with `status = DUPLICATE` and `duplicateOfId` set —
the requesting customer still sees their submission and its (shared) status rather than having it
vanish.

---

## 5. The path to a release

```
Customer → Recommendation → RoadmapItem → Feature → Module → Release
```

`RoadmapItem` is **platform-global**, not tenant-owned: several customers request the same thing
and each sees the shared status. When it reaches `RELEASED`, every linked recommendation can be
moved to `RELEASED` in one action, and every requesting customer sees it.

`RoadmapItem.moduleCode` connects a request to the module that will carry it, and
`RoadmapItem.isPublic` allows a public roadmap later without a schema change.

---

## 6. Rate limiting

Recommendation submission is rate limited per organization. It is an unauthenticated-adjacent
write path in the sense that any supervisor can reach it, and an unbounded one would be a cheap
way to fill a table.

---

## 7. Status

Domain and schema are complete. Routes and interface are pending — the customer-facing form is
part of the settings area and waits on the design reference.
