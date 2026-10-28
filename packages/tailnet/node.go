// The node's state, read from Tailscale every tick: sign-in, then Funnel, then the listeners and the link.

package main

import (
	"context"
	"strings"
	"time"

	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
)

// backend is what the state machine needs from tsnet (tsnet.go); tests fake it.
type backend interface {
	Status(ctx context.Context) (*ipnstate.Status, error)
	QueryFunnel(ctx context.Context) (*tailcfg.QueryFeatureResponse, error)
	StartLogin(ctx context.Context) error
	// Listen opens the Funnel listeners (443 for the web UI, 8443 for phones) and their proxies, once.
	Listen() error
}

const (
	// Funnel is asked about every 10 s while it is not allowed, and every 5 minutes while it is (it can be turned off).
	funnelRetry   = 10 * time.Second
	funnelRecheck = 5 * time.Minute
	// Ticks in NeedsLogin without a sign-in URL before asking for one (tsnet asks once, at start only).
	loginPatience = 3
)

type machine struct {
	b          backend
	now        func() time.Time
	listening  bool
	funnelOK   bool
	enableURL  string
	lastFunnel time.Time
	loginWait  int
}

func (m *machine) tick(ctx context.Context) State {
	st, err := m.b.Status(ctx)
	if err != nil {
		return State{State: "error", Message: err.Error()}
	}
	switch st.BackendState {
	case "NeedsLogin":
		m.funnelOK = false
		m.lastFunnel = time.Time{}
		if st.AuthURL != "" {
			m.loginWait = 0
			return State{State: "needs-login", AuthURL: st.AuthURL}
		}
		if m.loginWait++; m.loginWait >= loginPatience {
			m.loginWait = 0
			if err := m.b.StartLogin(ctx); err != nil {
				return State{State: "error", Message: "sign-in: " + err.Error()}
			}
		}
		return State{State: "needs-login"}
	case "NeedsMachineAuth":
		return State{State: "needs-login", Message: "machine-auth"}
	case "Running":
		m.loginWait = 0
		wait := funnelRetry
		if m.funnelOK {
			wait = funnelRecheck
		}
		if m.lastFunnel.IsZero() || m.now().Sub(m.lastFunnel) >= wait {
			m.lastFunnel = m.now()
			q, err := m.b.QueryFunnel(ctx)
			if err != nil {
				return State{State: "error", Message: "funnel: " + err.Error()}
			}
			m.funnelOK, m.enableURL = q.Complete, q.URL
		}
		if !m.funnelOK {
			return State{State: "needs-funnel", EnableURL: m.enableURL}
		}
		if !m.listening {
			if err := m.b.Listen(); err != nil {
				// Certificates can lag behind a fresh approval: ask again on the next round.
				m.funnelOK, m.lastFunnel = false, m.now()
				return State{State: "error", Message: err.Error()}
			}
			m.listening = true
		}
		return running(st)
	default:
		return State{State: "starting"}
	}
}

func running(st *ipnstate.Status) State {
	s := State{State: "running"}
	if st.Self == nil {
		return State{State: "starting"}
	}
	host := strings.TrimSuffix(st.Self.DNSName, ".")
	s.URL = "https://" + host
	s.DeviceURL = "https://" + host + ":8443"
	if u, ok := st.User[st.Self.UserID]; ok {
		s.Account = u.LoginName
	}
	if s.Account == "" && st.CurrentTailnet != nil {
		s.Account = st.CurrentTailnet.Name
	}
	if st.Self.KeyExpiry != nil {
		s.KeyExpiry = st.Self.KeyExpiry.UTC().Format(time.RFC3339)
	}
	return s
}
