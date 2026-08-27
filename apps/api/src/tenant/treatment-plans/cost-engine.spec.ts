import {
  PLAN_STATUSES,
  PLAN_STATUS_LABELS,
  PLAN_TIMESTAMP_COLUMN,
  allowedPlanTransitions,
  calculateLine,
  calculatePlan,
  canTransitionPlan,
  explainPlanRefusal,
  isPlanStatus,
  type PlanLineInput,
  type PlanStatus,
} from './cost-engine';

const line = (o: Partial<PlanLineInput> = {}): PlanLineInput => ({
  unitFee: 100,
  quantity: 1,
  discountAmount: 0,
  status: 'planned',
  ...o,
});

describe('line costing', () => {
  it('multiplies fee by quantity', () => {
    expect(calculateLine(line({ unitFee: 120, quantity: 3 })).subtotal).toBe(360);
  });

  it('subtracts the line discount', () => {
    const c = calculateLine(line({ unitFee: 200, quantity: 2, discountAmount: 50 }));
    expect(c.subtotal).toBe(400);
    expect(c.discountAmount).toBe(50);
    expect(c.total).toBe(350);
  });

  it('never returns a negative line, even on bad stored data', () => {
    const c = calculateLine(line({ unitFee: 100, discountAmount: 500 }));
    expect(c.total).toBe(0);
    expect(c.discountAmount).toBe(100);
  });

  it('treats a negative discount as zero', () => {
    expect(calculateLine(line({ discountAmount: -50 })).total).toBe(100);
  });

  it('floors quantity at 1 and fee at 0', () => {
    expect(calculateLine(line({ quantity: 0 })).subtotal).toBe(100);
    expect(calculateLine(line({ unitFee: -100 })).subtotal).toBe(0);
  });

  it('stays in integers — no floating-point residue', () => {
    for (const fee of [1, 7, 33, 99, 12345]) {
      for (const qty of [1, 3, 7]) {
        const c = calculateLine(line({ unitFee: fee, quantity: qty }));
        expect(Number.isInteger(c.subtotal)).toBe(true);
        expect(Number.isInteger(c.total)).toBe(true);
      }
    }
  });
});

describe('plan costing', () => {
  it('totals an empty plan to zero', () => {
    const c = calculatePlan([]);
    expect(c.subtotal).toBe(0);
    expect(c.total).toBe(0);
    expect(c.lineCount).toBe(0);
  });

  it('sums lines and applies both discount levels', () => {
    const c = calculatePlan(
      [
        line({ unitFee: 500, quantity: 1, discountAmount: 50 }),
        line({ unitFee: 200, quantity: 2 }),
      ],
      100,
    );
    expect(c.subtotal).toBe(900);       // 500 + 400
    expect(c.lineDiscounts).toBe(50);
    expect(c.planDiscount).toBe(100);
    expect(c.totalDiscount).toBe(150);
    expect(c.total).toBe(750);
  });

  it('excludes cancelled lines from every total', () => {
    const c = calculatePlan([
      line({ unitFee: 300 }),
      line({ unitFee: 900, status: 'cancelled' }),
    ]);
    expect(c.subtotal).toBe(300);
    expect(c.total).toBe(300);
    expect(c.cancelledLineCount).toBe(1);
    expect(c.lineCount).toBe(2);
  });

  it('caps the plan discount at what is left after line discounts', () => {
    const c = calculatePlan([line({ unitFee: 100, discountAmount: 40 })], 10_000);
    expect(c.planDiscount).toBe(60);
    expect(c.total).toBe(0);
  });

  it('splits completed from remaining work', () => {
    const c = calculatePlan([
      line({ unitFee: 400, status: 'completed' }),
      line({ unitFee: 600, status: 'planned' }),
    ]);
    expect(c.total).toBe(1000);
    expect(c.completedTotal).toBe(400);
    expect(c.remainingTotal).toBe(600);
    expect(c.completedLineCount).toBe(1);
  });

  it('keeps completed + remaining equal to the total', () => {
    const plans: PlanLineInput[][] = [
      [line({ unitFee: 333, status: 'completed' }), line({ unitFee: 667 })],
      [line({ unitFee: 100, status: 'completed', discountAmount: 25 })],
      [line({ unitFee: 50 }), line({ unitFee: 75, status: 'cancelled' })],
    ];
    for (const p of plans) {
      for (const planDiscount of [0, 10, 5000]) {
        const c = calculatePlan(p, planDiscount);
        expect(c.completedTotal + c.remainingTotal).toBe(c.total);
        expect(c.total).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('never lets a plan discount make completedTotal exceed the total', () => {
    const c = calculatePlan([line({ unitFee: 500, status: 'completed' })], 400);
    expect(c.total).toBe(100);
    expect(c.completedTotal).toBe(100);
    expect(c.remainingTotal).toBe(0);
  });

  it('reconciles: subtotal − totalDiscount === total', () => {
    const c = calculatePlan(
      [line({ unitFee: 1200, quantity: 2, discountAmount: 200 }), line({ unitFee: 80 })],
      75,
    );
    expect(c.subtotal - c.totalDiscount).toBe(c.total);
  });
});

describe('plan lifecycle', () => {
  it('declares exactly the six documented statuses', () => {
    expect(PLAN_STATUSES).toEqual([
      'draft', 'proposed', 'accepted', 'in_progress', 'completed', 'declined',
    ]);
  });

  it('walks the intended path', () => {
    expect(canTransitionPlan('draft', 'proposed')).toBe(true);
    expect(canTransitionPlan('proposed', 'accepted')).toBe(true);
    expect(canTransitionPlan('accepted', 'in_progress')).toBe(true);
    expect(canTransitionPlan('in_progress', 'completed')).toBe(true);
  });

  it('treats completed as terminal', () => {
    expect(allowedPlanTransitions('completed')).toEqual([]);
    for (const s of PLAN_STATUSES) expect(canTransitionPlan('completed', s)).toBe(false);
  });

  it('never accepts a plan that was never proposed to the patient', () => {
    expect(canTransitionPlan('draft', 'accepted')).toBe(false);
  });

  it('lets a declined plan be revived as a draft only', () => {
    expect(allowedPlanTransitions('declined')).toEqual(['draft']);
    expect(canTransitionPlan('declined', 'accepted')).toBe(false);
  });

  it('lets a proposal be pulled back to draft for editing', () => {
    expect(canTransitionPlan('proposed', 'draft')).toBe(true);
  });

  it('allows declining at any point before completion', () => {
    for (const s of ['draft', 'proposed', 'accepted', 'in_progress'] as PlanStatus[]) {
      expect(canTransitionPlan(s, 'declined')).toBe(true);
    }
  });

  it('never allows a self-transition', () => {
    for (const s of PLAN_STATUSES) expect(canTransitionPlan(s, s)).toBe(false);
  });

  it('can reach a terminal state from every status', () => {
    for (const start of PLAN_STATUSES) {
      const seen = new Set<PlanStatus>([start]);
      const queue: PlanStatus[] = [start];
      let reached = false;
      while (queue.length) {
        const cur = queue.shift()!;
        if (allowedPlanTransitions(cur).length === 0) { reached = true; break; }
        for (const n of allowedPlanTransitions(cur)) {
          if (!seen.has(n)) { seen.add(n); queue.push(n); }
        }
      }
      expect(reached).toBe(true);
    }
  });

  it('recognises only real statuses', () => {
    for (const s of PLAN_STATUSES) expect(isPlanStatus(s)).toBe(true);
    for (const bad of ['DRAFT', 'pending', '', null, 3, {}]) {
      expect(isPlanStatus(bad)).toBe(false);
    }
  });

  it('labels every status and stamps the right timestamps', () => {
    for (const s of PLAN_STATUSES) expect(PLAN_STATUS_LABELS[s]).toBeTruthy();
    expect(Object.keys(PLAN_TIMESTAMP_COLUMN).sort()).toEqual(
      ['accepted', 'completed', 'declined', 'proposed'],
    );
    // draft and in_progress are working states, not milestones.
    expect(PLAN_TIMESTAMP_COLUMN.draft).toBeUndefined();
    expect(PLAN_TIMESTAMP_COLUMN.in_progress).toBeUndefined();
  });

  it('explains every illegal move in words a receptionist can act on', () => {
    for (const from of PLAN_STATUSES) {
      for (const to of PLAN_STATUSES) {
        if (!canTransitionPlan(from, to)) {
          expect(explainPlanRefusal(from, to).length).toBeGreaterThan(10);
        }
      }
    }
    expect(explainPlanRefusal('completed', 'draft')).toContain('cannot be reopened');
    expect(explainPlanRefusal('draft', 'accepted')).toContain('Proposed');
  });
});
