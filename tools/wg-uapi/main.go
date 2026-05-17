// wg-uapi is a minimal WireGuard configuration tool that speaks the UAPI
// protocol directly over the wireguard-go Unix socket. It replaces the `wg`
// CLI for userspace WireGuard where the system `wg` binary only supports
// kernel netlink (e.g. the WireGuard Android APK's wg tool).
//
// Usage:
//
//	wg-uapi setconf <iface> <config-file>
//	wg-uapi set <iface> fwmark <value>
//
// The config file uses standard WireGuard INI format ([Interface]/[Peer]).
// Keys are converted from base64 (INI format) to hex (UAPI format).
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"strings"
)

const socketDir = "/var/run/wireguard"

func main() {
	if len(os.Args) < 3 {
		fatal("usage: wg-uapi {setconf <iface> <file> | set <iface> fwmark <val>}")
	}

	cmd := os.Args[1]
	switch cmd {
	case "setconf":
		if len(os.Args) != 4 {
			fatal("usage: wg-uapi setconf <iface> <config-file>")
		}
		iface := os.Args[2]
		confPath := os.Args[3]
		if err := setconf(iface, confPath); err != nil {
			fatal(err.Error())
		}
	case "set":
		// wg-uapi set <iface> fwmark <value>
		if len(os.Args) != 5 || os.Args[3] != "fwmark" {
			fatal("usage: wg-uapi set <iface> fwmark <value>")
		}
		iface := os.Args[2]
		fwmark := os.Args[4]
		if err := setFwmark(iface, fwmark); err != nil {
			fatal(err.Error())
		}
	default:
		fatal("unknown command: " + cmd + "\nusage: wg-uapi {setconf <iface> <file> | set <iface> fwmark <val>}")
	}
}

func fatal(msg string) {
	fmt.Fprintf(os.Stderr, "wg-uapi: %s\n", msg)
	os.Exit(1)
}

// b64ToHex converts a base64-encoded WireGuard key to hex for UAPI.
func b64ToHex(b64 string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil {
		return "", fmt.Errorf("invalid base64 key %q: %w", b64, err)
	}
	if len(raw) != 32 {
		return "", fmt.Errorf("key %q decoded to %d bytes, expected 32", b64, len(raw))
	}
	return hex.EncodeToString(raw), nil
}

// parseConf reads a WireGuard INI config and produces UAPI set lines.
func parseConf(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	var lines []string
	lines = append(lines, "set=1")

	scanner := bufio.NewScanner(f)
	inPeer := false
	peerCount := 0

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		if line == "[Interface]" {
			inPeer = false
			continue
		}
		if line == "[Peer]" {
			inPeer = true
			peerCount++
			if peerCount == 1 {
				lines = append(lines, "replace_peers=true")
			}
			continue
		}

		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		val := strings.TrimSpace(parts[1])

		if !inPeer {
			// [Interface] section
			switch key {
			case "PrivateKey":
				hexKey, err := b64ToHex(val)
				if err != nil {
					return "", err
				}
				lines = append(lines, "private_key="+hexKey)
			case "ListenPort":
				lines = append(lines, "listen_port="+val)
			case "FwMark":
				lines = append(lines, "fwmark="+val)
			}
		} else {
			// [Peer] section
			switch key {
			case "PublicKey":
				hexKey, err := b64ToHex(val)
				if err != nil {
					return "", err
				}
				lines = append(lines, "public_key="+hexKey)
			case "PresharedKey":
				hexKey, err := b64ToHex(val)
				if err != nil {
					return "", err
				}
				lines = append(lines, "preshared_key="+hexKey)
			case "Endpoint":
				lines = append(lines, "endpoint="+val)
			case "AllowedIPs":
				for _, cidr := range strings.Split(val, ",") {
					cidr = strings.TrimSpace(cidr)
					if cidr != "" {
						lines = append(lines, "allowed_ip="+cidr)
					}
				}
			case "PersistentKeepalive":
				lines = append(lines, "persistent_keepalive_interval="+val)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}

	// UAPI requires a trailing newline
	return strings.Join(lines, "\n") + "\n", nil
}

// uapiSend connects to the wireguard-go UAPI socket and sends a command.
// The UAPI protocol requires closing the write side (half-close) after sending
// the payload so wireguard-go knows the request is complete and responds.
// Returns an error if the response contains errno!=0.
func uapiSend(iface, payload string) error {
	sockPath := socketDir + "/" + iface + ".sock"
	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		return fmt.Errorf("connect to %s: %w", sockPath, err)
	}
	defer conn.Close()

	_, err = conn.Write([]byte(payload))
	if err != nil {
		return fmt.Errorf("write to UAPI socket: %w", err)
	}

	// Half-close the write side so wireguard-go knows the request is complete
	if uc, ok := conn.(*net.UnixConn); ok {
		uc.CloseWrite()
	}

	// Read response - UAPI responds with key=value lines, ending with errno=N
	scanner := bufio.NewScanner(conn)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "errno=") {
			errno := strings.TrimPrefix(line, "errno=")
			if errno != "0" {
				return fmt.Errorf("UAPI error: errno=%s", errno)
			}
			return nil
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("reading UAPI response: %w", err)
	}

	return fmt.Errorf("UAPI response missing errno line")
}

func setconf(iface, confPath string) error {
	payload, err := parseConf(confPath)
	if err != nil {
		return fmt.Errorf("parsing config: %w", err)
	}
	return uapiSend(iface, payload)
}

func setFwmark(iface, fwmark string) error {
	payload := "set=1\nfwmark=" + fwmark + "\n"
	return uapiSend(iface, payload)
}
