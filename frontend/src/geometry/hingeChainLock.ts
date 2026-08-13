import { columnKey, type Row } from './tilingLinAlg'
import type { HingeChain } from './hingeChains'
import { signatureOf } from './tilingCotangent'
import type { TilingGraphState } from '../types/tilingGraph'

/** The only pieces of a `HingeChain` this module's math actually reads --
 * narrowed out (rather than requiring a full `HingeChain`) so a
 * `HingeChainLock` persisted in `TilingGraphState` (which stores just
 * these fields, not a full live chain -- see that type's doc) can be
 * reconstructed and passed straight in, without filler for `id`/`points`/
 * `termination`. A real `HingeChain` structurally satisfies this too, so
 * callers with a live chain (the canvas, right after selecting two) need
 * no change either. */
export type HingeChainRef = Pick<HingeChain, 'sourceLegIds' | 'sourceTangentAngles' | 'tangentLegId' | 'initialAngle' | 'crossings'>

/**
 * The chain-collinearity lock: given two hinge chains that both cross some
 * common tiling-graph leg, derives the ONE linear row that forces them to
 * cross it at the same point (i.e. be collinear through it), by walking
 * each chain from its source all the way to its own crossing point ON the
 * common leg, then equating the two (see `walkToCommonLeg`'s doc for why
 * the walk must include that final hop rather than stopping short of it).
 *
 * Generalizes `tilingCotangent.ts`'s trick (eliminate synthetic unknowns
 * analytically, keep only real vertex-position columns in the final row)
 * from one 4-edge cotangency to a whole chain. Every equation here has the
 * same homogeneous `n . (X - Y) = 0` shape as `tilingGraphOps.ts`'s
 * `legRow`, so every synthetic point along the way -- the source's own
 * tangent point `Q`, and each hinge crossing point -- ends up a PURE LINEAR
 * (no constant term) combination of real vertex-column coefficients.
 * Represented as a `Row['coeffs']`-shaped map per axis and built up via
 * straightforward forward substitution (a 3x3 solve at the source, then a
 * 2x2 solve per hop): each step's unknowns are exactly determined by the
 * previous step's already-known expression plus one new real vertex, so
 * substituting forward never re-introduces an eliminated synthetic term.
 *
 * Orientation note: a raw, undirected 3-tangent-line system is genuinely
 * ambiguous -- which side of a non-parallel line the true incircle center
 * sits on is a real geometric fact, not something derivable from the 3 line
 * equations alone, so simply using each leg's stored `angle` as-is can (and,
 * on real data, does) solve for the WRONG of two valid points, mirrored
 * across whichever line got the "wrong" side. `unlike `cotangentRow` (which
 * resolves this via face-relative CCW orientation), this module never sees
 * face structure or positions -- so every tangent angle used here
 * (`HingeChain.sourceTangentAngles`, `CrossingAnchor`'s `orientedAngles`) is
 * expected to already be pre-oriented, toward the real known position, by
 * `geometry/hingeChains.ts` at chain-computation time, and is used exactly
 * as given with no further correction.
 */

const ZERO_EPS = 1e-9

/** A synthetic point's value, as a pure linear combination of real
 * vertex-position columns (see the module doc) -- `x`/`y` are each a
 * `Row['coeffs']`-shaped map. */
interface AffineExpr {
  x: Record<string, number>
  y: Record<string, number>
}

function pointColumn(vertexId: string): AffineExpr {
  return { x: { [columnKey(vertexId, 'x')]: 1 }, y: { [columnKey(vertexId, 'y')]: 1 } }
}

/** `sum(scale_i * expr_i)` over a list of `[expr, scale]` pairs. */
function linComb(terms: Array<[Record<string, number>, number]>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [expr, scale] of terms) {
    if (scale === 0) continue
    for (const [k, v] of Object.entries(expr)) out[k] = (out[k] ?? 0) + v * scale
  }
  return out
}

function det3x3(m: number[][]): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  )
}

/** Standard cofactor/adjugate 3x3 inverse -- `inverse[i][j] = cofactor[j][i] / det`. */
function invert3x3(m: number[][], det: number): number[][] {
  const c00 = m[1][1] * m[2][2] - m[1][2] * m[2][1]
  const c01 = -(m[1][0] * m[2][2] - m[1][2] * m[2][0])
  const c02 = m[1][0] * m[2][1] - m[1][1] * m[2][0]
  const c10 = -(m[0][1] * m[2][2] - m[0][2] * m[2][1])
  const c11 = m[0][0] * m[2][2] - m[0][2] * m[2][0]
  const c12 = -(m[0][0] * m[2][1] - m[0][1] * m[2][0])
  const c20 = m[0][1] * m[1][2] - m[0][2] * m[1][1]
  const c21 = -(m[0][0] * m[1][2] - m[0][2] * m[1][0])
  const c22 = m[0][0] * m[1][1] - m[0][1] * m[1][0]
  return [
    [c00 / det, c10 / det, c20 / det],
    [c01 / det, c11 / det, c21 / det],
    [c02 / det, c12 / det, c22 / det],
  ]
}

interface TangentLegRef {
  angle: number
  vertexId: string
}

/**
 * Solves for the source vertex's own tangent point `Q` from exactly 3 of
 * its tangent legs: `n_i . Q - r = n_i . p_i` for `i = 0, 1, 2`, where
 * `p_i` is a representative point on leg `i`'s line (either endpoint works
 * -- both satisfy that leg's own line equation by construction, see
 * `tilingGraphOps.ts`'s `legRow`) and `n_i = (-sin(angle_i), cos(angle_i))`.
 * Three equations, three unknowns `(Qx, Qy, r)`; `r` itself is discarded
 * (nothing downstream needs it). `tangents` must already be pre-oriented
 * (see the module doc's orientation note) -- callers pass
 * `HingeChain.sourceTangentAngles`/`CrossingAnchor.orientedAngles`, never a
 * leg's raw stored `angle` directly. Returns `null` if the 3 legs' directions
 * don't span a unique solution (e.g. all 3 are parallel).
 */
function solveSourcePoint(tangents: TangentLegRef[]): AffineExpr | null {
  const n = tangents.map((t) => ({ nx: -Math.sin(t.angle), ny: Math.cos(t.angle), vertexId: t.vertexId }))
  const m = n.map(({ nx, ny }) => [nx, ny, -1])
  const det = det3x3(m)
  if (Math.abs(det) < ZERO_EPS) return null
  const inv = invert3x3(m, det)
  const rhs = n.map(({ nx, ny, vertexId }) => {
    const p = pointColumn(vertexId)
    return linComb([
      [p.x, nx],
      [p.y, ny],
    ])
  })
  const qx = linComb(rhs.map((expr, i) => [expr, inv[0][i]] as [Record<string, number>, number]))
  const qy = linComb(rhs.map((expr, i) => [expr, inv[1][i]] as [Record<string, number>, number]))
  return { x: qx, y: qy }
}

/**
 * One hop along a chain: given the previous point's already-solved
 * expression, the fixed (position-independent) direction leaving it
 * (`hopAngle`), and the mirror line it crosses next (`crossedLineAngle` +
 * `anchor`, an already-solved expression for some point known to lie on
 * that line -- a real vertex column for a leg or ridge-boundary-vertex
 * anchor, or another node's own solved tangent point for a ridge-interior
 * anchor), solves the 2x2 system `perp(hopAngle) . (C - prev) = 0`,
 * `perp(crossedLineAngle) . (C - anchor) = 0` for the new crossing point
 * `C`. Returns `null` if `hopAngle` and `crossedLineAngle` are
 * (numerically) parallel -- the hop direction never actually reaches the
 * crossed line.
 */
function solveHop(prev: AffineExpr, hopAngle: number, crossedLineAngle: number, anchor: AffineExpr): AffineExpr | null {
  const nxHop = -Math.sin(hopAngle)
  const nyHop = Math.cos(hopAngle)
  const nxLeg = -Math.sin(crossedLineAngle)
  const nyLeg = Math.cos(crossedLineAngle)
  const det = nxHop * nyLeg - nyHop * nxLeg
  if (Math.abs(det) < ZERO_EPS) return null
  const rhsA = linComb([
    [prev.x, nxHop],
    [prev.y, nyHop],
  ])
  const rhsB = linComb([
    [anchor.x, nxLeg],
    [anchor.y, nyLeg],
  ])
  const cx = linComb([
    [rhsA, nyLeg / det],
    [rhsB, -nyHop / det],
  ])
  const cy = linComb([
    [rhsB, nxHop / det],
    [rhsA, -nxLeg / det],
  ])
  return { x: cx, y: cy }
}

/** The first leg id that both chains cross (checked in `chainA`'s own
 * crossing order, so the result is deterministic) -- `null` if they share
 * none. Only `anchor.kind === 'leg'` crossings count -- a chain-collinearity
 * lock is specifically about two chains sharing a real path leg, not an
 * incidental shared ridge, and not either chain's own tangent legs or
 * termination vertex. */
export function findCommonLeg(chainA: HingeChainRef, chainB: HingeChainRef): string | null {
  const legsB = new Set(
    chainB.crossings.filter((c) => c.anchor.kind === 'leg').map((c) => (c.anchor as { kind: 'leg'; legId: string }).legId),
  )
  for (const crossing of chainA.crossings) {
    if (crossing.anchor.kind === 'leg' && legsB.has(crossing.anchor.legId)) return crossing.anchor.legId
  }
  return null
}

/** Solves a skeleton node's own tangent point from its (up to 3 used)
 * tangent legs -- shared by a chain's own source (`walkToCommonLeg`) and
 * any `'node'`-anchored ridge crossing encountered while walking through
 * it (see `CrossingAnchor`'s doc), since both are the exact same kind of
 * "3 tangent lines -> one point" system, and both come with their own
 * pre-oriented angles (`sourceTangentAngles`/`orientedAngles`) computed
 * once, alongside `legIds`, by `geometry/hingeChains.ts`. `cache` memoizes
 * by tangent-leg signature so a node hit by both chains (or by the same
 * chain twice) is only solved once per `buildHingeChainConstraint` call. */
function solveNodePoint(
  legIds: string[],
  orientedAngles: number[],
  graph: TilingGraphState,
  cache: Map<string, AffineExpr | null>,
): AffineExpr | { error: string } {
  const sig = signatureOf(legIds)
  if (!cache.has(sig)) {
    const tangentRefs: TangentLegRef[] = []
    for (let i = 0; i < legIds.length && tangentRefs.length < 3; i++) {
      const leg = graph.legs[legIds[i]]
      if (!leg) {
        cache.set(sig, null)
        break
      }
      tangentRefs.push({ angle: orientedAngles[i], vertexId: leg.vertexA })
    }
    cache.set(sig, tangentRefs.length === 3 ? solveSourcePoint(tangentRefs) : null)
  }
  const q = cache.get(sig)!
  return q ?? { error: "A straight-skeleton vertex this hinge chain depends on no longer admits a common incircle point." }
}

/** Walks `chain` from its source all the way to (and including) the hop
 * across `commonLegId` itself (its first `anchor.kind === 'leg'` occurrence
 * in `chain.crossings`), returning that crossing point's solved expression
 * -- `X`, the point where this chain's own hinge meets the common leg.
 * Walks through every intervening crossing, leg AND ridge alike (see
 * `CrossingAnchor`'s doc) -- a chain that transmits through one leg into a
 * neighboring face routinely bounces off that face's own internal ridge(s)
 * before reaching its next real leg, so treating only leg crossings as
 * hop-connected (skipping the ridge bounces in between) would solve for the
 * wrong point: the straight-line-hop assumption only holds between
 * consecutive bounces of ANY kind, not consecutive LEG bounces specifically.
 *
 * Deliberately does NOT stop one hop short of the common leg: `chain.crossings[0]`
 * is always the chain's own source tangent leg (every hinge's first bounce
 * is, by construction, the tangent point on the edge it started
 * perpendicular to), so an early version of this stopped at `crossings[idx - 1]`
 * and connected *that* point to the other chain's, on the theory that the
 * final hop "doesn't need" its own crossing-point variable. That shortcut is
 * only valid when the final hop's direction happens to be perpendicular to
 * the common leg (then a point's position *along* the leg is preserved by
 * that last hop, and only its offset needs equating) -- not true in general
 * (a chain reaching the common leg at some other angle, the common case),
 * where it silently measured the wrong quantity. Solving the same 2x2 hop
 * system one further time, through the common leg like any other crossing,
 * is correct unconditionally and costs nothing extra.
 *
 * Special-cases `chain.tangentLegId === commonLegId` (the source's OWN
 * tangent leg IS the common leg) by returning `q` directly, without
 * consulting `chain.crossings` at all. `HingeChainLock`'s persisted side
 * (`sideLock` in `state/actions/tilingGraphActions.ts`) stores
 * `crossings.slice(0, idx + 1)` -- INCLUDING the common-leg crossing itself,
 * since a later re-derivation from the persisted lock (`hingeChainLockRows`,
 * which runs on every `finalize` to keep the null space in sync) needs to
 * find `commonLegId` inside `chain.crossings` again via the lookup just
 * below; excluding it (an earlier version of `sideLock` did) meant that
 * lookup could never succeed post-persistence, silently dropping this
 * lock's row from the constraint set from the very first `finalize` after
 * commit (the position solve at LOCK-CREATION time still used the live
 * chain directly, so the crease visually snapped correctly immediately,
 * but the null space never actually incorporated the constraint, letting a
 * later drag walk right off it). When that crossing is `crossings[0]`
 * (this exact case), though, the persisted array is `[crossings[0]]` --
 * still findable in principle, but checking `tangentLegId` first sidesteps
 * the lookup entirely,
 * since `q` (the source's own tangent point) already lies exactly on its
 * own tangent leg by construction -- no hop needed either way. */
function walkToCommonLeg(
  chain: HingeChainRef,
  commonLegId: string,
  graph: TilingGraphState,
  cache: Map<string, AffineExpr | null>,
): AffineExpr | { error: string } {
  const q = solveNodePoint(chain.sourceLegIds, chain.sourceTangentAngles, graph, cache)
  if ('error' in q) return q
  if (chain.tangentLegId === commonLegId) return q

  const idx = chain.crossings.findIndex((c) => c.anchor.kind === 'leg' && c.anchor.legId === commonLegId)
  if (idx === -1) return { error: 'internal: common leg not found in chain' }

  let current = q
  let angle = chain.initialAngle
  for (let i = 0; i <= idx; i++) {
    const crossing = chain.crossings[i]
    let lineAngle: number
    let anchor: AffineExpr
    if (crossing.anchor.kind === 'leg') {
      const leg = graph.legs[crossing.anchor.legId]
      if (!leg) return { error: 'A leg this hinge chain depends on no longer exists.' }
      lineAngle = leg.angle
      anchor = pointColumn(leg.vertexA)
    } else if (crossing.anchor.kind === 'vertex') {
      if (!graph.vertices[crossing.anchor.vertexId]) return { error: 'A vertex this hinge chain depends on no longer exists.' }
      lineAngle = crossing.mirrorAngle
      anchor = pointColumn(crossing.anchor.vertexId)
    } else {
      const node = solveNodePoint(crossing.anchor.legIds, crossing.anchor.orientedAngles, graph, cache)
      if ('error' in node) return node
      lineAngle = crossing.mirrorAngle
      anchor = node
    }
    const next = solveHop(current, angle, lineAngle, anchor)
    if (!next) return { error: 'This hinge chain bends through a degenerate crossing.' }
    current = next
    angle = crossing.angleAfter
  }
  return current
}

/**
 * Builds the single row forcing `chainA` and `chainB` to be collinear
 * through `commonLegId`: walks both chains all the way to their own
 * crossing point on it (`xA`/`xB`, see `walkToCommonLeg`), then equates
 * them via a `legRow`-shaped row with `angle = commonLeg.angle + pi/2` --
 * since both points are already constrained to lie ON the common leg
 * (by construction, from each chain's own last hop), equating their
 * position *along* the leg (zeroing the component of `xB - xA` orthogonal
 * to it) is sufficient to force them to be the exact same point.
 */
export function buildHingeChainConstraint(
  chainA: HingeChainRef,
  chainB: HingeChainRef,
  commonLegId: string,
  graph: TilingGraphState,
): { row: Row } | { error: string } {
  const commonLeg = graph.legs[commonLegId]
  if (!commonLeg) return { error: 'The common leg no longer exists.' }

  // Shared across both walks (and within a single walk) so a skeleton node
  // hit more than once -- e.g. both chains passing through the same
  // ridge-interior node, or one chain bouncing off it twice -- is only
  // solved once.
  const cache = new Map<string, AffineExpr | null>()
  const xA = walkToCommonLeg(chainA, commonLegId, graph, cache)
  if ('error' in xA) return xA
  const xB = walkToCommonLeg(chainB, commonLegId, graph, cache)
  if ('error' in xB) return xB

  const connectorAngle = commonLeg.angle + Math.PI / 2
  const nx = -Math.sin(connectorAngle)
  const ny = Math.cos(connectorAngle)
  const coeffs = linComb([
    [xB.x, nx],
    [xA.x, -nx],
    [xB.y, ny],
    [xA.y, -ny],
  ])
  return { row: { coeffs, b: 0 } }
}
