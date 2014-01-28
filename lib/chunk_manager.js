var util = require("util");
var EventEmitter = require("events").EventEmitter;
var assert = require("assert");

// see https://github.com/substack/_buffer-handbook
//     http://blog.nodejs.org/2012/12/20/streams2/
//     http://codewinds.com/blog/2013-08-20-nodejs-transform-streams.html
//
function ChunkManager(chunk_size) {
    chunk_size = chunk_size || 1024;
    this.chunk_size=chunk_size;
    this.chunk = new Buffer(this.chunk_size);
    this.cursor = 0;

}
util.inherits(ChunkManager, EventEmitter);

ChunkManager.prototype.write = function(buffer,length) {

    assert(buffer instanceof Buffer || (buffer === null) );
    assert(length!=0);

    var l = length;
    var input_cursor =0;

    while (l>0) {
        assert(length-input_cursor!==0);

        if (this.cursor==0) {
            // let the client to write some stuff at the start of the chunk
            if (!this._in_before_chunk) {
                this._in_before_chunk = true;
                this.emit("before_chunk",this.chunk);
                this._in_before_chunk = false;
            }
        }
        // space left in current chunk
        var space_left = this.chunk_size - this.cursor;

        var nb_to_write =Math.min(length-input_cursor,space_left);

        if (buffer) {
            buffer.copy(this.chunk,this.cursor,input_cursor,input_cursor+nb_to_write);
        } else {
            // just reserving space
        }

        input_cursor+=nb_to_write;
        this.cursor +=nb_to_write;
        if (this.cursor>=this.chunk_size) {
            this.emit("chunk",this.chunk);
            this.cursor = 0;
        }
        l-=nb_to_write;
    }
};
ChunkManager.prototype.end = function() {
    if (this.cursor>0) {
        n = this.chunk_size  - this.cursor;
        for (;this.cursor<this.chunk_size;this.cursor++) {
            this.chunk.writeUInt8(n % 256 ,this.cursor);
        }
        this.emit("chunk",this.chunk.slice(0,this.cursor));
        this.cursor =0;
    }
}


exports.ChunkManager = ChunkManager;


var through = require("through2");

var ChunkStream = function(chunkManager) {

    var  cm = chunkManager;
    var tr = through(function(chunk,enc,next) {
       cm.write(chunk,chunk.length);
       next();
    },function() {
        cm.end();
    });
    cm.on("chunk",function(chunk) {
        tr.push(chunk);
    });
    return tr;
};
exports.ChunkStream = ChunkStream;




/**
 * MessageChunkManager split message in chunks and add a header in front
 * of each chunk.
 *
 * the header is described in OPC Unified Architecture, Part 6 page 36.
 *
 * @param messageSize
 * @param msgType
 * @param secureChannelId
 * @constructor
 */

var counter = 0;
function MessageChunkManager(messageSize,msgType,secureChannelId)
{
    msgType = msgType || "HEL";
    secureChannelId = secureChannelId || 0;
    assert(msgType.length===3);
    assert(messageSize>12);

    this.messageSize  = messageSize;
    this.msgType      = msgType;
    this.secureChannelId = secureChannelId;
    this.sizeOfHeader = 12;
    this.bodySize     = messageSize-this.sizeOfHeader;
    this.chunkManager = new ChunkManager(this.bodySize);
    this.offsetBody   = 0 + this.sizeOfHeader;

    var self = this;

    this.chunkManager.on("chunk",function(chunk) {

       self._sendPendingChunk("C");

       var buf = new Buffer(chunk.length + self.sizeOfHeader);
       chunk.copy(buf,self.offsetBody,0,chunk.length);

       self.pendingChunk = buf;

    }).on("before_chunk",function() {

    });
}
util.inherits(MessageChunkManager, EventEmitter);


MessageChunkManager.prototype.write_header_and_footer = function(finalC,buf) {

    assert(finalC.length === 1);
    // reserve space for header
    var self = this;
    assert(buf instanceof Buffer);
    buf.writeUInt8(this.msgType.charCodeAt(0),0);
    buf.writeUInt8(this.msgType.charCodeAt(1),1);
    buf.writeUInt8(this.msgType.charCodeAt(2),2);
    buf.writeUInt8(finalC.charCodeAt(0),3);
    buf.writeUInt32LE(this.messageSize,4);
    buf.writeUInt32LE(this.secureChannelId,8);

};


MessageChunkManager.prototype.write = function(buffer,length) {

   this.chunkManager.write(buffer,length);

};
MessageChunkManager.prototype._sendPendingChunk = function(finalC) {

    assert(finalC.length === 1);

    if (this.pendingChunk) {

        var buf = this.pendingChunk;
        this.write_header_and_footer(finalC,buf);

        this.emit("chunk",buf);
        this.pendingChunk = 0;
    }

};

MessageChunkManager.prototype.abort = function() {
    this.chunkManager.end();
    this._sendPendingChunk("A");
};

MessageChunkManager.prototype.end = function() {
   // send pending chunk ...
   this.chunkManager.end();
   this._sendPendingChunk("F");
};

exports.MessageChunkManager = MessageChunkManager;