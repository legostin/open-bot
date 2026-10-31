package main

import (
	"bufio"
	"bytes"
	"strings"
	"testing"
)

func TestReadStart(t *testing.T) {
	in := bufio.NewReader(strings.NewReader(`{"type":"start","dir":"/d","hostname":"piomio","web":"127.0.0.1:1","device":"127.0.0.1:2","deviceCert":"C","deviceKey":"K"}` + "\n" + `{"type":"logout"}` + "\n"))
	s, err := readStart(in)
	if err != nil {
		t.Fatal(err)
	}
	if s.Dir != "/d" || s.Hostname != "piomio" || s.Web != "127.0.0.1:1" || s.Device != "127.0.0.1:2" || s.DeviceCert != "C" || s.DeviceKey != "K" {
		t.Fatalf("start: %+v", s)
	}
	cmds := make(chan string, 4)
	readCommands(in, cmds)
	if got := <-cmds; got != "logout" {
		t.Fatalf("command: %q", got)
	}
	if _, ok := <-cmds; ok {
		t.Fatal("the channel stays open after stdin ends")
	}
}

func TestReadStartRejectsIncomplete(t *testing.T) {
	for _, line := range []string{"", "not json\n", `{"type":"start","dir":"/d"}` + "\n", `{"type":"logout"}` + "\n"} {
		if _, err := readStart(bufio.NewReader(strings.NewReader(line))); err == nil {
			t.Fatalf("accepted %q", line)
		}
	}
}

func TestEmitWritesChangesOnly(t *testing.T) {
	var buf bytes.Buffer
	e := &emitter{w: &buf}
	e.emit(State{State: "needs-login", AuthURL: "https://login.tailscale.com/a/x"})
	e.emit(State{State: "needs-login", AuthURL: "https://login.tailscale.com/a/x"})
	e.emit(State{State: "running", URL: "https://piomio.t.ts.net"})
	want := `{"type":"state","state":"needs-login","authUrl":"https://login.tailscale.com/a/x"}` + "\n" + `{"type":"state","state":"running","url":"https://piomio.t.ts.net"}` + "\n"
	if buf.String() != want {
		t.Fatalf("got\n%s\nwant\n%s", buf.String(), want)
	}
}
