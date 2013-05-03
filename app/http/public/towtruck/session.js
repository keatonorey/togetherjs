/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

define(["require", "util", "channels", "jquery", "storage"], function (require, util, channels, $, storage) {

  var DEBUG = true;

  var session = util.mixinEvents(util.Module("session"));
  var assert = util.assert;

  // We will load this module later (there's a circular import):
  var peers;

  // This is the hub we connect to:
  session.shareId = null;
  // This is the ID that identifies this client:
  session.clientId = null;
  session.router = channels.Router();
  // Indicates if TowTruck has just started (not continuing from a saved session):
  session.firstRun = false;

  // This is the key we use for localStorage:
  var localStoragePrefix = "towtruck.";
  // This is the channel to the hub:
  var channel = null;
  // For testing:
  session._getChannel = function () {
    return channel;
  };

  // Setting, essentially global:
  session.AVATAR_SIZE = 90;

  var MAX_SESSION_AGE = 30*24*60*60*1000; // 30 days

  /****************************************
   * URLs
   */

  session.hubUrl = function () {
    assert(session.shareId, "URL cannot be resolved before TowTruck.shareId has been initialized");
    return TowTruck.getConfig("hubBase") + "/hub/" + session.shareId;
  };

  session.shareUrl = function () {
    assert(session.shareId, "Attempted to access shareUrl() before shareId is set");
    var hash = location.hash;
    var m = /\?[^#]*/.exec(location.href);
    var query = "";
    if (m) {
      query = m[0];
    }
    hash = hash.replace(/&?towtruck-[a-zA-Z0-9]+/, "");
    hash = hash || "#";
    return location.protocol + "//" + location.host + location.pathname + query +
           hash + "&towtruck=" + session.shareId;
  };

  session.recordUrl = function () {
    assert(session.shareId);
    var url = TowTruck.baseUrl.replace(/\/*$/, "") + "/recorder.html";
    url += "#&towtruck=" + session.shareId + "&hubBase=" + TowTruck.getConfig("hubBase");
    return url;
  };

  /* location.href without the hash */
  session.currentUrl = function () {
    return location.href.replace(/#.*/, "");
  };

  /****************************************
   * Message handling/dispatching
   */

  session.hub = util.mixinEvents({});

  var IGNORE_MESSAGES = ["cursor-update", "keydown", "scroll-update"];

  function openChannel() {
    assert(! channel);
    console.info("Connecting to", session.hubUrl(), location.href);
    var c = channels.WebSocketChannel(session.hubUrl());
    c.onmessage = function (msg) {
      if (DEBUG && IGNORE_MESSAGES.indexOf(msg.type) == -1) {
        console.info("In:", msg);
      }
      msg.peer = peers.getPeer(msg.clientId, msg);
      if (msg.type == "hello" || msg.type == "hello-back" || msg.type == "peer-update") {
        // We do this here to make sure this is run before any other
        // hello handlers:
        msg.peer.updateFromHello(msg);
      }
      msg.sameUrl = msg.peer.url == currentUrl;
      msg.peer.lastMessageDate = Date.now();
      session.hub.emit(msg.type, msg);
      TowTruck._onmessage(msg);
    };
    channel = c;
    session.router.bindChannel(channel);
  }

  // FIXME: once we start looking at window.history we need to update this:
  var currentUrl = (location.href + "").replace(/\#.*$/, "");

  session.send = function (msg) {
    if (DEBUG && IGNORE_MESSAGES.indexOf(msg.type) == -1) {
      console.info("Send:", msg);
    }
    msg.clientId = session.clientId;
    channel.send(msg);
  };

  session.appSend = function (msg) {
    var type = msg.type;
    if (type.search(/^towtruck\./) === 0) {
      type = type.substr("towtruck.".length);
    } else if (type.search(/^app\./) === -1) {
      type = "app." + type;
    }
    msg.type = type;
    session.send(msg);
  };

  /****************************************
   * Standard message responses
   */

  /* Always say hello back, and keep track of peers: */
  session.hub.on("hello hello-back", function (msg) {
    if (msg.type == "hello") {
      sendHello(true);
    }
  });

  function sendHello(helloBack) {
    var msg = {
      name: peers.Self.name || peers.Self.defaultName,
      avatar: peers.Self.avatar,
      color: peers.Self.color,
      url: session.currentUrl(),
      urlHash: location.hash,
      // FIXME: titles update, we should track those changes:
      title: document.title,
      rtcSupported: session.RTCSupported
    };
    if (helloBack) {
      msg.type = "hello-back";
    } else {
      msg.type = "hello";
      msg.clientVersion = TowTruck.version;
    }
    if (! TowTruck.startup.continued) {
      msg.starting = true;
    }
    session.send(msg);
  }

  /****************************************
   * Lifecycle (start and end)
   */

  // These are Javascript files that implement features, and so must
  // be injected at runtime because they aren't pulled in naturally
  // via define().
  // ui must be the first item:
  var features = ["ui", "chat", "tracker", "webrtc", "cursor", "startup", "peers"];

  function initIdentityId() {
    return util.Deferred(function (def) {
      if (session.identityId) {
        def.resolve();
        return;
      }
      storage.get("identityId").then(function (identityId) {
        if (! identityId) {
          identityId = util.generateId();
          storage.set("identityId", identityId);
        }
        session.identityId = identityId;
        // We don't actually have to wait for the set to succede, so
        // long as session.identityId is set
        def.resolve();
      });
    });
  }

  initIdentityId.done = initIdentityId();

  function initShareId() {
    return util.Deferred(function (def) {
      var hash = location.hash;
      var shareId = session.shareId;
      var isClient = true;
      var set = true;
      var sessionId;
      session.firstRun = ! TowTruck.startup.continued;
      if (! shareId) {
        if (TowTruck.startup._joinShareId) {
          // Like, below, this *also* means we got the shareId from the hash
          // (in towtruck.js):
          shareId = TowTruck.startup._joinShareId;
        }
      }
      if (! shareId) {
        // FIXME: I'm not sure if this will ever happen, because towtruck.js should
        // handle it
        var m = /&?towtruck=([^&]*)/.exec(hash);
        if (m) {
          isClient = ! m[1];
          shareId = m[2];
          var newHash = hash.substr(0, m.index) + hash.substr(m.index + m[0].length);
          location.hash = newHash;
        }
      }
      return storage.tab.get("status").then(function (saved) {
        if (! saved) {
          isClient = false;
          if (! shareId) {
            shareId = util.generateId();
          }
          if (! sessionId) {
            sessionId = util.generateId();
          }
        } else {
          isClient = saved.reason == "joined";
          TowTruck.startup.reason = saved.reason;
          TowTruck.startup.continued = true;
          shareId = saved.shareId;
          sessionId = saved.sessionId;
          // The only case when we don't need to set the storage status again is when
          // we're already set to be running
          set = ! saved.running;
        }
        assert(session.identityId);
        session.clientId = session.identityId + "." + sessionId;
        if (set) {
          storage.tab.set("status", {reason: TowTruck.startup.reason, shareId: shareId, running: true, date: Date.now(), sessionId: sessionId});
        }
        session.isClient = isClient;
        session.shareId = shareId;
        session.emit("shareId");
        def.resolve(session.shareId);
      });
    });
  }

  function initStartTarget() {
    var id;
    if (TowTruck.startup.button) {
      id = TowTruck.startup.button.id;
      if (id) {
        storage.set("startTarget", id);
      }
      return;
    }
    storage.get("startTarget").then(function (id) {
      var el = document.getElementById(id);
      if (el) {
        TowTruck.startup.button = el;
      }
    });
  }

  session.start = function () {
    initStartTarget();
    initIdentityId().then(function () {
      initShareId().then(function () {
        openChannel();
        require(["ui"], function (ui) {
          TowTruck.running = true;
          ui.prepareUI();
          require(features, function () {
            $(function () {
              peers = require("peers");
              var startup = require("startup");
              session.emit("start");
              session.once("ui-ready", function () {
                startup.start();
              });
              var ui = require("ui");
              ui.activateUI();
              if (TowTruck.getConfig("enableAnalytics")) {
                require(["analytics"], function (analytics) {
                  analytics.activate();
                });
              }
              peers._SelfLoaded.then(function () {
                sendHello(false);
              });
              TowTruck.emit("ready");
            });
          });
        });
      });
    });
  };

  session.close = function () {
    TowTruck.running = false;
    session.send({type: "bye"});
    session.emit("close");
    var name = window.name;
    storage.tab.get("status").then(function (saved) {
      if (! saved) {
        console.warn("No session information saved in", "status." + name);
      } else {
        saved.running = false;
        saved.date = Date.now();
        storage.tab.set("status", undefined);
      }
      channel.close();
      channel = null;
      session.shareId = null;
      session.emit("shareId");
      TowTruck.emit("close");
    });
  };

  if (TowTruck.startup._launch) {
    setTimeout(session.start);
  }

  return session;
});
