package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
)

type fakeBackend struct {
	st      ipnstate.Status
	funnel  tailcfg.QueryFeatureResponse
	queries int
	logins  int
	listens int
	listen  error
}

func (f *fakeBackend) Status(context.Context) (*ipnstate.Status, error) { s := f.st; return &s, nil }
func (f *fakeBackend) QueryFunnel(context.Context) (*tailcfg.QueryFeatureResponse, error) {
	f.queries++
	q := f.funnel
	return &q, nil
}
func (f *fakeBackend) StartLogin(context.Context) error { f.logins++; return nil }
func (f *fakeBackend) Listen() error                    { f.listens++; return f.listen }

func TestMachineWalksSignInFunnelRunning(t *testing.T) {
	ctx := context.Background()
	clock := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	b := &fakeBackend{}
	m := &machine{b: b, now: func() time.Time { return clock }}

	b.st = ipnstate.Status{BackendState: "NoState"}
	if s := m.tick(ctx); s.State != "starting" {
		t.Fatalf("%+v", s)
	}

	b.st = ipnstate.Status{BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/abc"}
	if s := m.tick(ctx); s != (State{State: "needs-login", AuthURL: "https://login.tailscale.com/a/abc"}) {
		t.Fatalf("%+v", s)
	}

	// Signed out later: tsnet does not ask for a new URL, the machine does after a few ticks.
	b.st = ipnstate.Status{BackendState: "NeedsLogin"}
	for i := 0; i < loginPatience; i++ {
		m.tick(ctx)
	}
	if b.logins != 1 {
		t.Fatalf("logins %d", b.logins)
	}

	expiry := time.Date(2027, 4, 25, 0, 0, 0, 0, time.UTC)
	b.st = ipnstate.Status{
		BackendState: "Running",
		Self:         &ipnstate.PeerStatus{DNSName: "piomio.tail1234.ts.net.", UserID: 7, KeyExpiry: &expiry},
		User:         map[tailcfg.UserID]tailcfg.UserProfile{7: {LoginName: "anna@example.com"}},
	}
	b.funnel = tailcfg.QueryFeatureResponse{URL: "https://login.tailscale.com/f/funnel?node=n1"}
	if s := m.tick(ctx); s != (State{State: "needs-funnel", EnableURL: "https://login.tailscale.com/f/funnel?node=n1"}) {
		t.Fatalf("%+v", s)
	}
	m.tick(ctx)
	if b.queries != 1 {
		t.Fatalf("asked about Funnel %d times within 10 s", b.queries)
	}

	b.funnel = tailcfg.QueryFeatureResponse{Complete: true}
	clock = clock.Add(funnelRetry)
	want := State{State: "running", URL: "https://piomio.tail1234.ts.net", DeviceURL: "https://piomio.tail1234.ts.net:8443", Account: "anna@example.com", KeyExpiry: "2027-04-25T00:00:00Z"}
	if s := m.tick(ctx); s != want {
		t.Fatalf("%+v", s)
	}
	m.tick(ctx)
	if b.listens != 1 {
		t.Fatalf("listened %d times", b.listens)
	}

	// Funnel turned off in the tailnet: noticed at the next recheck.
	b.funnel = tailcfg.QueryFeatureResponse{URL: "https://login.tailscale.com/f/funnel?node=n1"}
	clock = clock.Add(funnelRecheck)
	if s := m.tick(ctx); s.State != "needs-funnel" {
		t.Fatalf("%+v", s)
	}
}

func TestMachineRetriesListenAfterAnError(t *testing.T) {
	ctx := context.Background()
	clock := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	b := &fakeBackend{
		st:     ipnstate.Status{BackendState: "Running", Self: &ipnstate.PeerStatus{DNSName: "piomio.t.ts.net."}},
		funnel: tailcfg.QueryFeatureResponse{Complete: true},
		listen: errors.New("no certificate yet"),
	}
	m := &machine{b: b, now: func() time.Time { return clock }}
	if s := m.tick(ctx); s.State != "error" || s.Message != "no certificate yet" {
		t.Fatalf("%+v", s)
	}
	b.listen = nil
	clock = clock.Add(funnelRetry)
	if s := m.tick(ctx); s.State != "running" {
		t.Fatalf("%+v", s)
	}
}
