package main

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"tailscale.com/ipn"
)

func TestProxySetsHostAndForwardedHeaders(t *testing.T) {
	seen := make(chan *http.Request, 1)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r
		io.WriteString(w, "hi")
	}))
	defer backend.Close()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := serveProxy(ln, strings.TrimPrefix(backend.URL, "http://"))
	defer srv.Close()

	req, _ := http.NewRequest("GET", "http://"+ln.Addr().String()+"/api/auth/state", nil)
	req.Host = "owlbot.example.ts.net"
	req.Header.Set("X-Forwarded-For", "6.6.6.6")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if string(body) != "hi" {
		t.Fatalf("body %q", body)
	}
	r := <-seen
	if r.Host != "owlbot.example.ts.net" || r.URL.Path != "/api/auth/state" {
		t.Fatalf("host %q path %q", r.Host, r.URL.Path)
	}
	if got := r.Header.Get("X-Forwarded-For"); got != "127.0.0.1" {
		t.Fatalf("X-Forwarded-For %q: the client's own value must not pass", got)
	}
	if r.Header.Get("X-Forwarded-Proto") != "https" || r.Header.Get("X-Forwarded-Host") != "owlbot.example.ts.net" {
		t.Fatalf("headers %v", r.Header)
	}
}

func TestProxyPassesWebSocketUpgrades(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Upgrade") != "websocket" {
			http.Error(w, "no upgrade", 400)
			return
		}
		c, rw, _ := w.(http.Hijacker).Hijack()
		defer c.Close()
		rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
		rw.Flush()
		line, _ := rw.ReadString('\n')
		rw.WriteString("echo " + line)
		rw.Flush()
	}))
	defer backend.Close()
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	srv := serveProxy(ln, strings.TrimPrefix(backend.URL, "http://"))
	defer srv.Close()

	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	io.WriteString(c, "GET /api/ws HTTP/1.1\r\nHost: owlbot.example.ts.net\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
	r := bufio.NewReader(c)
	status, _ := r.ReadString('\n')
	if !strings.Contains(status, "101") {
		t.Fatalf("status %q", status)
	}
	for {
		l, _ := r.ReadString('\n')
		if l == "\r\n" || l == "" {
			break
		}
	}
	io.WriteString(c, "ping\n")
	if got, _ := r.ReadString('\n'); got != "echo ping\n" {
		t.Fatalf("got %q", got)
	}
}

func TestClientIPOfFunnelConnections(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	f := &ipn.FunnelConn{Conn: a, Src: netip.MustParseAddrPort("203.0.113.7:51000")}
	if got := clientIP(f); got != "203.0.113.7" {
		t.Fatalf("funnel %q", got)
	}
}
