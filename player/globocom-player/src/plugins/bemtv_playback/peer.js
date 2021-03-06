var BaseObject = require('../../base/base_object');
var utils = require('./utils.js');
var rtc_quickconnect = require('rtc-quickconnect');
var rtc_bufferedchannel = require('rtc-bufferedchannel');
var freeice = require('freeice');
var _ = require('underscore');

BEMTV_ROOM_DISCOVER_URL = "http://server.bem.tv/room"
BEMTV_SERVER = "http://server.bem.tv:8080"

var Peer = BaseObject.extend({
  initialize: function(container, el, cache) {
    this.container = container;
    this.listenTo(this.container, "container:state:bufferfull", this.onBufferFull);
    this.el = el;
    this.cache = cache;
    this.swarm = {};
    this.peersServed = {};
    this.room = this.discoverRoom(BEMTV_ROOM_DISCOVER_URL);
    this.connect();
  },
  connect: function() {
    connection = rtc_quickconnect(BEMTV_SERVER, {room: this.room, iceServers: freeice()});
    console.log("[bemtv] connecting to " + this.room);
    this.createDataChannel(connection);
  },
  createDataChannel: function(connection) {
    dataChannel = connection.createDataChannel(this.room); // disable heartbeat?
    dataChannel.on(this.room + ':open', this.onOpen.bind(this));
    dataChannel.on('peer:leave', this.onDisconnect.bind(this));
    console.log("[bemtv] connected. ");
  },
  discoverRoom: function(url) {
    response = utils.request(url);
    return response? JSON.parse(response)['room']: "bemtv";
  },
  onOpen: function(dc, id) {
    console.log("[bemtv] peer " + id + " joined");
    this.swarmAdd(id, dc);
    if (this.container.getPluginByName('stats').getStats()['watchingTime']) {
      this.send(id, _.extend({"msg": "PING"}, this.getScoreParameters()));
    }
  },
  onBufferFull: function() {
    _.each(this.swarm, function(peer) {
      setTimeout(function() {
        this.send(peer.id, _.extend({"msg": "PING"}, this.getScoreParameters()));
      }.bind(this), 2000);
    }.bind(this));
  },
  send: function(id, message) {
    var sendingTime = Date.now();
    try {
      this.swarm[id].dataChannel.send(JSON.stringify({"msg" : message, 'sendingTime': sendingTime}));
    } catch(err) {
      console.log("[bemtv] oops, error sending to " + id);
    }
  },
  recv: function(id, message) {
    data = JSON.parse(message);
    rtt = Math.abs(Date.now() - data.sendingTime);
    msg = data.msg['msg'];
    if (msg == "PING") {
      this.actionsForPing(id, data);
    } else if (msg == "DES") {
      this.actionsForDes(id, data);
    } else if (msg == "REQ") {
      this.actionsForReq(id, data);
    } else if (msg == "DESACK") {
      this.actionsForDesack(id, data);
    } else if (msg == "OFFER") {
      this.actionsForOffer(id, data);
    }
  },
  actionsForPing: function(id, data) {
    this.swarm[id]["score"] = this.calculateScore(_.extend({"rtt":rtt}, data.msg.scoreParams));
    this.swarm[id] = _.extend(this.swarm[id], data.msg.scoreParams); // erase this line after score calculation
    this.swarm[id]["isAhead"] = _.indexOf(Object.keys(this.cache), data.msg.scoreParams.lastFragmentUri, true) === 1? false: true;
  },
  actionsForDes: function(id, data) {
    _.each(this.cache, function(chunk) {
      if (chunk.url == data.msg.url) {
        this.send(id, {"msg": "DESACK", "url": data.msg.url});
      }
    }.bind(this));
  },
  actionsForDesack: function(id, data) {
    if (this.currentUrl == data.msg.url) {
      this.send(id, {"msg": "REQ", "url": data.msg.url});
    }
  },
  actionsForReq: function(id, data) {
    _.each(this.cache, function(chunk) {
      if (chunk.url == data.msg.url) {
        var size = chunk.data.length;
        console.log('[bemtv] sending ' + this.currentUrl.match(".*/(.*ts)")[1] + " with size " + size);
        this.send(id, {"msg": "OFFER", "url": data.msg.url, "content": chunk.data, "length": size});
        var current = this.container.getPluginByName("stats").getStats()["chunksSent"];
        this.container.statsAdd({"chunksSent": current+1});
      }
    }.bind(this));
  },
  actionsForOffer: function(id, data) {
    console.log('[bemtv] ' + this.currentUrl.match(".*/(.*ts)")[1] + " from P2P");
    if (data.msg.content.length == data.msg.length) {
      clearTimeout(this.timeoutId);
      this.el.resourceLoaded(data.msg.content);
      this.cache.push({url: data.msg.url , data: data.msg.content});
      var current = this.container.getPluginByName("stats").getStats()["chunksReceivedP2P"];
      this.container.statsAdd({"chunksReceivedP2P": current+1});
    } else {
      console.log("[bemtv] oops, corrupted chunk received. ("+ data.msg.content.length +" != "+data.msg.length+")");
    }
  },
  calculateScore: function(params) {
    console.log("Need to calculate score for: ", params);
    return 600;
  },
  swarmAdd: function(id, dc) {
    dataChannel = rtc_bufferedchannel(dc, {calcCharSize: false});
    this.swarm[id] = {"dataChannel" : dataChannel, "score": undefined, "id": id};
    dataChannel.on('data', function(data) { this.onData(id, data); }.bind(this));
  },
  onData: function(id, data) {
    this.recv(id, data);
  },
  onDisconnect: function(id) {
    console.log("[bemtv] peer " + id + " disconnected.");
    delete this.swarm[id];
  },
  getScoreParameters: function() {
    this.metrics = this.container.getPluginByName('stats').getStats();
    return {"scoreParams": {"wt": this.metrics['watchingTime'] || 0,
            "rt": this.metrics['rebufferingTime'] || 0 ,
            "tps": this.peersServed.length || 0,
            "lastFragmentUri": this.el.getLastFragmentUrl()}};
  },
  requestResource: function(url, timeoutId) {
    _.each(this.swarm, function(peer) {
      if (peer.isAhead) {
        console.log("[bemtv] peer is ahead, asking if he have the chunk");
        this.send(peer.id, {"msg": "DES", "url": url});
      } else {
        console.log("[bemtv] peer is behind, skipping");
      }
    }.bind(this));
    this.currentUrl = url;
    this.timeoutId = timeoutId;
  },
});

module.exports = Peer;
