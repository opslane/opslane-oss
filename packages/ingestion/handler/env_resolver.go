package handler

import (
	"container/list"
	"context"
	"regexp"
	"sync"
	"sync/atomic"
	"time"
)

const environmentResolverCapacity = 1000

var environmentNamePattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
var disabledEnvironmentFallbackSamples atomic.Uint64

type environmentLookup func(context.Context, string, string) (string, error)

type environmentCacheKey struct {
	projectID string
	name      string
}

type environmentCacheEntry struct {
	key       environmentCacheKey
	id        string
	expiresAt time.Time
}

// environmentResolver is a small bounded, tenant-keyed LRU. Negative entries
// expire quickly so a newly-created environment becomes usable promptly.
type environmentResolver struct {
	mu       sync.Mutex
	entries  map[environmentCacheKey]*list.Element
	lru      *list.List
	lookup   environmentLookup
	now      func() time.Time
	capacity int
}

func newEnvironmentResolver(lookup environmentLookup, now func() time.Time) *environmentResolver {
	if now == nil {
		now = time.Now
	}
	return &environmentResolver{
		entries:  make(map[environmentCacheKey]*list.Element),
		lru:      list.New(),
		lookup:   lookup,
		now:      now,
		capacity: environmentResolverCapacity,
	}
}

func (r *environmentResolver) resolve(ctx context.Context, projectID, name string) (string, error) {
	key := environmentCacheKey{projectID: projectID, name: name}
	now := r.now()
	r.mu.Lock()
	if element := r.entries[key]; element != nil {
		entry := element.Value.(*environmentCacheEntry)
		if now.Before(entry.expiresAt) {
			r.lru.MoveToFront(element)
			id := entry.id
			r.mu.Unlock()
			return id, nil
		}
		r.lru.Remove(element)
		delete(r.entries, key)
	}
	r.mu.Unlock()

	id, err := r.lookup(ctx, projectID, name)
	if err != nil {
		return "", err
	}
	ttl := 60 * time.Second
	if id == "" {
		ttl = 5 * time.Second
	}

	r.mu.Lock()
	if element := r.entries[key]; element != nil {
		r.lru.Remove(element)
	}
	entry := &environmentCacheEntry{key: key, id: id, expiresAt: now.Add(ttl)}
	r.entries[key] = r.lru.PushFront(entry)
	for r.lru.Len() > r.capacity {
		oldest := r.lru.Back()
		delete(r.entries, oldest.Value.(*environmentCacheEntry).key)
		r.lru.Remove(oldest)
	}
	r.mu.Unlock()
	return id, nil
}

func (d *Dependencies) environmentNameResolver() *environmentResolver {
	d.envResolverMu.Lock()
	defer d.envResolverMu.Unlock()
	if d.envResolver == nil {
		d.envResolver = newEnvironmentResolver(d.Queries.FindEnvironmentIDByName, time.Now)
	}
	return d.envResolver
}

// resolvePayloadEnvironment applies the project opt-in and validation rules.
// It always returns the key-bound id on an override fallback.
func (d *Dependencies) resolvePayloadEnvironment(ctx context.Context, projectID, keyEnvironmentID, name string) (string, string, error) {
	if name == "" {
		return keyEnvironmentID, "", nil
	}
	if !AllowPayloadEnvironmentFromCtx(ctx) {
		return keyEnvironmentID, "disabled", nil
	}
	if !environmentNamePattern.MatchString(name) {
		return keyEnvironmentID, "invalid_name", nil
	}
	id, err := d.environmentNameResolver().resolve(ctx, projectID, name)
	if err != nil {
		return "", "", err
	}
	if id == "" {
		return keyEnvironmentID, "unknown_name", nil
	}
	return id, "", nil
}

func shouldLogEnvironmentFallback(reason string) bool {
	if reason != "disabled" {
		return true
	}
	// Disabled is the expected compatibility fallback while older projects use
	// newer SDKs, so emit only the first and every 1024th occurrence.
	return disabledEnvironmentFallbackSamples.Add(1)%1024 == 1
}
