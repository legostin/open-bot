// piomio-tailnet: the Piomio hub's own Tailscale node. The hub starts it, sends the start line on stdin and reads its
// state lines on stdout; once Funnel is allowed it serves https://<hostname>.<tailnet>.ts.net (the web UI) and
// :8443 (the phones) by proxying to the hub's loopback gateways. Closing stdin stops it; {"type":"logout"} signs the
// node out first.

package main

import (
	"bufio"
	"context"
	"log"
	"os"
	"time"

	"tailscale.com/tsnet"
)

func main() {
	// Piomio does not send Tailscale its node logs.
	os.Setenv("TS_NO_LOGS_NO_SUPPORT", "true")
	log.SetFlags(0)
	log.SetOutput(os.Stderr)

	out := &emitter{w: os.Stdout}
	in := bufio.NewReader(os.Stdin)
	start, err := readStart(in)
	if err != nil {
		out.emit(State{State: "error", Message: err.Error()})
		os.Exit(2)
	}
	if err := os.MkdirAll(start.Dir, 0o700); err != nil {
		out.emit(State{State: "error", Message: err.Error()})
		os.Exit(1)
	}
	cmds := make(chan string)
	go readCommands(in, cmds)

	out.emit(State{State: "starting"})
	srv := &tsnet.Server{Dir: start.Dir, Hostname: start.Hostname, UserLogf: log.Printf}
	if err := srv.Start(); err != nil {
		out.emit(State{State: "error", Message: err.Error()})
		os.Exit(1)
	}
	lc, err := srv.LocalClient()
	if err != nil {
		out.emit(State{State: "error", Message: err.Error()})
		os.Exit(1)
	}
	b := &tsBackend{srv: srv, lc: lc, start: start}
	defer b.Close()
	m := &machine{b: b, now: time.Now}

	tick := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		out.emit(m.tick(ctx))
	}
	tick()
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case c, ok := <-cmds:
			if !ok {
				return
			}
			if c == "logout" {
				ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				if err := lc.Logout(ctx); err != nil {
					log.Printf("logout: %v", err)
				}
				cancel()
				return
			}
		case <-ticker.C:
			tick()
		}
	}
}
