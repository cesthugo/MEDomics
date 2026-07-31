// starhe.go — Reverse proxy MEDomics → serveur STARHE standalone
//
// Toutes les requêtes /starhe/* et /starhe/ui/* reçues par le serveur Go
// MEDomics sont transmises au serveur Go STARHE (port STARHE_SERVER_PORT,
// défaut 8082).
//
// Routes exposées par ce blueprint :
//   /starhe/ui/*   → http://localhost:8082/ui/*   (interface React STARHE)
//   /starhe/*      → http://localhost:8082/starhe/* (API REST STARHE)
//
// Le frontend MEDomics n'a ainsi qu'un seul point d'entrée (le port MEDomics)
// pour piloter le plugin — pas de CORS, pas de port secondaire visible.
package starhe

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

// starheServerURL retourne l'adresse du serveur STARHE standalone.
// On force 127.0.0.1 (et non "localhost") : sur Windows "localhost" peut se
// résoudre en IPv6 ::1 alors que le serveur STARHE écoute en IPv4, ce qui fait
// échouer le proxy ("STARHE server unavailable").
func starheServerURL() string {
	port := os.Getenv("STARHE_SERVER_PORT")
	if port == "" {
		port = "8082"
	}
	return "http://127.0.0.1:" + port
}

// newProxy crée un reverse proxy vers le serveur STARHE.
// rewritePath est appelé sur le chemin de la requête avant transmission ;
// passer nil conserve le chemin d'origine.
func newProxy(rewritePath func(string) string) *httputil.ReverseProxy {
	target, err := url.Parse(starheServerURL())
	if err != nil {
		log.Fatalf("STARHE blueprint: URL invalide — %v", err)
	}

	return &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host
			req.Host = target.Host
			if rewritePath != nil {
				req.URL.Path = rewritePath(req.URL.Path)
				if req.URL.RawQuery != "" {
					req.URL.RawPath = req.URL.Path
				}
			}
			req.Header.Del("X-Forwarded-For")
		},
		// Empêche Chromium de cacher les fichiers STARHE (index.html notamment) —
		// sans ça, un re-montage du composant React sert l'ancienne version depuis le
		// cache même si renderer/dist/ vient d'être reconstruit.
		ModifyResponse: func(resp *http.Response) error {
			resp.Header.Set("Cache-Control", "no-store, no-cache, must-revalidate")
			resp.Header.Del("Pragma")
			return nil
		},
		// FlushInterval court indispensable pour que le SSE (/starhe/analyze)
		// ne soit pas mis en tampon par le proxy.
		FlushInterval: 50 * time.Millisecond,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("STARHE proxy error (%s): %v", r.URL.Path, err)
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, `{"error":"STARHE server unavailable — start the plugin first"}`, http.StatusBadGateway)
		},
	}
}

// corsHandler ajoute les en-têtes CORS et gère les pré-vols OPTIONS.
func corsHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// AddHandleFunc enregistre les deux routes du proxy STARHE sur DefaultServeMux.
func AddHandleFunc() {
	// /starhe/ui/* → http://localhost:8082/ui/*
	// On retire le préfixe "/starhe" pour que "/starhe/ui/foo" devienne "/ui/foo".
	uiProxy := newProxy(func(path string) string {
		return strings.TrimPrefix(path, "/starhe")
	})
	http.Handle("/starhe/ui/", corsHandler(uiProxy))

	// /starhe/* → http://localhost:8082/starhe/*
	// Le chemin est transmis tel quel (ex: /starhe/analyze → /starhe/analyze).
	// Enregistré APRÈS /starhe/ui/ ; Go's ServeMux donne la priorité
	// au pattern le plus long, donc /starhe/ui/ est toujours préféré.
	apiProxy := newProxy(nil)
	http.Handle("/starhe/", corsHandler(apiProxy))

	log.Printf("STARHE blueprint: /starhe/ui/* → %s/ui/", starheServerURL())
	log.Printf("STARHE blueprint: /starhe/*    → %s/starhe/*", starheServerURL())
}
