package notify

import (
	"context"
	"testing"
)

func TestPruneDeletesOldTerminalRowsInBatchesAndOrphanEvents(t *testing.T) {
	pool := testPool(t)
	cipher := testCipher(t)
	ctx := context.Background()
	old := make([]seededDelivery, 0, 3)
	for i := 0; i < 3; i++ {
		seed := seedDelivery(t, pool, cipher, "http://sink.test:9999/hook")
		old = append(old, seed)
		if _, err := pool.Exec(ctx, `
			UPDATE outbound_deliveries SET status = 'delivered', updated_at = now() - interval '31 days'
			WHERE id = $1`, seed.DeliveryID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE outbound_events SET created_at = now() - interval '31 days' WHERE id = $1`, seed.EventID); err != nil {
			t.Fatal(err)
		}
	}
	fresh := seedDelivery(t, pool, cipher, "http://sink.test:9999/fresh")

	deliveries, events, err := New(pool, cipher, Options{}).prune(ctx, 2)
	if err != nil {
		t.Fatal(err)
	}
	if deliveries != 3 || events != 3 {
		t.Fatalf("pruned deliveries=%d events=%d", deliveries, events)
	}
	var oldDeliveries, oldEvents int
	if err := pool.QueryRow(ctx, `
		SELECT
		  (SELECT count(*) FROM outbound_deliveries WHERE id = ANY($1::uuid[])),
		  (SELECT count(*) FROM outbound_events WHERE id = ANY($2::uuid[]))`,
		[]string{old[0].DeliveryID, old[1].DeliveryID, old[2].DeliveryID},
		[]string{old[0].EventID, old[1].EventID, old[2].EventID}).Scan(&oldDeliveries, &oldEvents); err != nil {
		t.Fatal(err)
	}
	if oldDeliveries != 0 || oldEvents != 0 {
		t.Fatalf("old rows remain: deliveries=%d events=%d", oldDeliveries, oldEvents)
	}
	var freshStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM outbound_deliveries WHERE id = $1`, fresh.DeliveryID).Scan(&freshStatus); err != nil {
		t.Fatal(err)
	}
	if freshStatus != "pending" {
		t.Fatalf("fresh pending row changed to %s", freshStatus)
	}
}
