// The line protocol with the hub: JSON lines over stdin (the start line, then commands) and stdout (states).

package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
)

// Start is the hub's first line: where the node keeps its keys, its name and where the proxies send traffic.
type Start struct {
	Type       string `json:"type"`
	Dir        string `json:"dir"`
	Hostname   string `json:"hostname"`
	Web        string `json:"web"`
	Device     string `json:"device"`
	DeviceCert string `json:"deviceCert"`
	DeviceKey  string `json:"deviceKey"`
}

// State is what the hub shows: a state line replaces the previous one.
type State struct {
	Type      string `json:"type"`
	State     string `json:"state"`
	URL       string `json:"url,omitempty"`
	DeviceURL string `json:"deviceUrl,omitempty"`
	AuthURL   string `json:"authUrl,omitempty"`
	EnableURL string `json:"enableUrl,omitempty"`
	Account   string `json:"account,omitempty"`
	KeyExpiry string `json:"keyExpiry,omitempty"`
	Message   string `json:"message,omitempty"`
}

func readStart(r *bufio.Reader) (Start, error) {
	line, err := r.ReadString('\n')
	if err != nil && (err != io.EOF || strings.TrimSpace(line) == "") {
		return Start{}, errors.New("no start line on stdin")
	}
	var s Start
	if err := json.Unmarshal([]byte(line), &s); err != nil {
		return Start{}, errors.New("the start line is not JSON: " + err.Error())
	}
	if s.Type != "start" || s.Dir == "" || s.Hostname == "" || s.Web == "" || s.Device == "" || s.DeviceCert == "" || s.DeviceKey == "" {
		return Start{}, errors.New("the start line needs type, dir, hostname, web, device, deviceCert and deviceKey")
	}
	return s, nil
}

// readCommands sends the type of every later line ("logout") and closes the channel when stdin ends.
func readCommands(r *bufio.Reader, out chan<- string) {
	defer close(out)
	for {
		line, err := r.ReadString('\n')
		if strings.TrimSpace(line) != "" {
			var c struct {
				Type string `json:"type"`
			}
			if json.Unmarshal([]byte(line), &c) == nil && c.Type != "" {
				out <- c.Type
			}
		}
		if err != nil {
			return
		}
	}
}

// emitter writes a state line only when the state changed.
type emitter struct {
	mu   sync.Mutex
	w    io.Writer
	last State
}

func (e *emitter) emit(s State) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	s.Type = "state"
	if s == e.last {
		return false
	}
	b, err := json.Marshal(s)
	if err != nil {
		return false
	}
	if _, err := e.w.Write(append(b, '\n')); err != nil {
		return false
	}
	e.last = s
	return true
}
