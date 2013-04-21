define(['async', 'x_types', 'endianbuffer', 'rgb_colors'], function (async, x_types, EndianBuffer, rgb_colors) {
  var window = null;
  
  function XServerClient (server, id, resource_id_base, resource_id_mask) {
    this.server = server;
    this.id = id;
    this.state = 0;
    this.endian = null;
    this.release = 11300000;
    this.resource_id_mask = resource_id_mask;
    this.resource_id_base = resource_id_base;
    this.vendor = 'JavaScript X';
    this.motion_buffer_size = 0xff;
    this.maximum_request_length = 0xffff;
    this.sequence = 1;
    this.sequence_sent = 0;
    this.save_set = [];
    this.reqs = [];
    this.reps = [];
    this.events = [];
    this.closedown = 'destroy';
  }

  XServerClient.prototype.write = function (data) {
    return this.server.write(this, data);
  }

  XServerClient.prototype.processData = function (data) {
    data.endian = this.endian;
    if (this.buffer) {
      var data_new = new EndianBuffer(data.length + this.buffer.length);
      data_new.endian = this.endian;
      this.buffer.copy(data_new, 0);
      data.copy(data_new, this.buffer.length);
      delete this.buffer;
      data = data_new;
    }
    switch (this.state) {
      case 0:
        return this.setup(data);
      case 1:
        var req = { length: 0 };
        while (data.length > 0) {
          req = new x_types.Request(data, this.sequence)
          if (req.length > data.length) {
            this.buffer = data;
            break;
          }
          this.sequence = this.sequence + 1;
          this.reqs.push(req);
          if (data.length > 0) {
            data = data.slice(req.length);
            data.endian = this.endian;
          }
        }
        this.reqs.push(null); // Force a processReps after this batch!
        if ((!this.server.grab) || this === this.server.grab )
          this.processReqs();
    }
  }

  XServerClient.prototype.processReqs = function () {
    var self = this;
    if (self.server.grab && self.server.grab !== self)
      return self.reqs_processing = false;
    if (self.reqs_processing)
      return;
    clearTimeout(self.reqs_timeout);
    if (self.reqs.length) {
      self.reqs_processing = true;
      self.reqs_timeout = setTimeout(function () {
        var req = self.reqs.shift();
        if (req) {
          var func = self[XServerClient.opcodes[req.opcode]];
          if (func) {
            console.group(req.sequence, self.sequence, self.sequence_sent, self.id, req.opcode, XServerClient.opcodes[req.opcode]);
            try {
              func && func.call(self, req, function (err, rep) {
                if (rep) {
                  if (Array.isArray(rep))
                    self.reps = self.reps.concat(rep)
                  else
                    self.reps.push(rep);
                }
                self.reqs_processing = false;
                self.processReqs()
              });
            } catch (e) {
              if (e instanceof x_types.Error) {
                e.opcode = req.opcode;
                e.sequence = req.sequence & 0xffff;
                console.error(self.id, e, e.stack);
                self.reps.push(e);
                self.reqs_processing = false;
                self.processReqs();
              } else {
                console.error('Implementation Error');
                self.reps.push(new x_types.Error(req, 17, 0));
                throw e;
              }
            }
            console.groupEnd();
          } else {
            console.error('################### UNKNOWN OPCODE', req.opcode);
            // Send Implementation error
            self.reps.push(new x_types.Error(req, 17, 0));
            self.reqs_processing = false;
            self.processReqs()
          }
        } else {
          self.processReps();
          self.reqs_processing = false;
          self.processReqs()
        }
      }, 0);
    } else
      self.processReps();
  }

  XServerClient.prototype.processReps = function () {
    var self = this;
    if (self.reps_processing)
      return;
    clearTimeout(self.reps_timeout);
    if (self.reps.length || self.events.length) {
      self.reps_processing = true;
      self.reps_timeout = setTimeout(function () {
        var reps = self.reps.splice(0, self.reps.length).filter(function (rep) { return rep })
        if (reps.length === 0 && self.events.length)
          reps = self.events.splice(0, self.events.length);
        if (reps.length) {
          var res = new EndianBuffer(
                reps.reduce(function (o, rep) { return o + rep.length }, 0)
              );
          res.endian = self.endian;
          reps.reduce(function (o, rep) {
            if (rep instanceof x_types.events.Event)
              rep.sequence = self.sequence_sent;
            if(self.sequence_sent < rep.sequence)
              self.sequence_sent = rep.sequence;
            return rep.writeBuffer(res, o);
          }, 0);
          self.write(res);
        }
        self.reps_processing = false;
      });
    } else
      self.reps_processing = false;
  }

  XServerClient.prototype.sendEvent = function (event) {
    this.reps.push(event);
    console.warn('client.sendEvent', event);
    if (! (this.reps_processing || this.reqs_processing))
      this.processReps();
  }

  XServerClient.prototype.disconnect = function () {
    console.log('Disconnect', this.id);
    var self = this;
    delete this.server.clients[this.id];
    if (this.closedown === 'destroy')
      Object.keys(this.server.resources)
        .forEach(function (resource) {
          resource = self.server.resources[resource];
          if (! resource)
            return;
          if (resource.owner === self)
            resource.destroy();
        });
  }

  XServerClient.prototype.setup = function (data) {
    data.endian = this.endian = data.readUInt8(0) !== 66; // TODO: Investigate endianness issues here (swapped?)... (true === LE, arrghhhhhhh!)
    this.protocol_major = data.readUInt16(2);
    this.protocol_minor = data.readUInt16(4);

    this.auth_name = data.toString(
        'ascii'
      , 12
      , 12 + data.readUInt16(6, data.endian)
    );

    this.auth_data = data.toString(
        'ascii'
      , 12 + data.readUInt16(6, data.endian) + 2
      , 12 + data.readUInt16(6, data.endian) + 2 + data.readUInt16(8, data.endian)
    );

    /* Deny connection
    var reason = 'No Way'
      , pad = 4 - ((reason.length % 4) || 4);

    var res = new EndianBuffer(8 + reason.length + pad);
    res.fill(0);
    res.writeUInt8(reason.length, 1); // 2 (0: 0, 1: reason.length)
    this.writeUInt16(res, this.protocol_major, 2); // 2
    this.writeUInt16(res, this.protocol_minor, 4); // 2
    this.writeUInt16(res, (reason.length + pad) / 4, 6);
    res.write(reason, 8, reason.length, 'ascii');
    this.socket.write(res);
    */
    // Allow connection

    var res = new EndianBuffer(500);
    res.endian = this.endian;
    res.writeUInt8(1, 0);
    res.writeUInt16(this.server.protocol_major, 2);
    res.writeUInt16(this.server.protocol_minor, 4);
    res.writeUInt16((32 + (this.server.formats.byteLength()) + stringPad(this.server.vendor) + this.server.screens.byteLength()) / 4, 6);
    res.writeUInt32(this.server.release, 8);
    res.writeUInt32(this.resource_id_base, 12);
    res.writeUInt32(this.resource_id_mask, 16);
    res.writeUInt32(this.motion_buffer_size, 20);
    res.writeUInt16(this.server.vendor.length, 24);
    res.writeUInt16(this.maximum_request_length, 26);
    res.writeUInt8(this.server.screens.length, 28); // Number screens
    res.writeUInt8(this.server.formats.length, 29); // Number formats
    res.writeUInt8(0, 30); // image lsb first
    res.writeUInt8(0, 31); // pixmap lsb first
    res.writeUInt8(32, 32); // pixmap scanline unit
    res.writeUInt8(32, 33); // pixmap scanline pad
    res.writeUInt8(8, 34); // min keycode
    res.writeUInt8(255, 35); // max keycode
    // 4 unused
    res.write(this.server.vendor, 40, this.server.vendor.length, 'ascii');
    var base = 40 + stringPad(this.server.vendor);
    base = this.server.formats.writeBuffer(res, base);
    base = this.server.screens.writeBuffer(res, base);
    var rep = new EndianBuffer(base);
    rep.fill(0);
    res.copy(rep, 0, 0, base);
    this.write(rep);
    this.state = 1;
  }

  XServerClient.prototype.imageFromBitmap = function (dest, data, depth, width, height, pad) {
    var format = this.server.getFormatByDepth(depth)
      , scanline_pad_unit = format.scanline_pad / format.bpp
      , scanline = width + (scanline_pad_unit - (width % scanline_pad_unit || format.scanline));
    switch (depth) {
      case 1:
        var byte;
        for (var row = 0; row < height; row ++) {
          for (var col = 0; col < width; col ++) {
            var data_offset = (row * scanline) + col
              , dest_offset = (row * width) + col
              , bit = col % 8
              , bit_mask = Math.pow(2, bit);
            if (bit == 0)
              byte = data.readUInt8(data_offset / 8);
            dest.data[dest_offset] =
            dest.data[dest_offset + 1] =
            dest.data[dest_offset + 2] = (byte & bit_mask) ? 0xff : 0x00;
            dest.data[dest_offset + 3] = 0xff;
          }
        }
      break;
      default:
        throw new Error('Bitmap with depth ' + depth + ' not implemented!');
    }
    return dest;
  }

  XServerClient.prototype.imageToBitmap = function (data, depth, width, height) {
    throw new Error('STUB: Implement imageToBitmap')
  }

  XServerClient.prototype.imageFromXYPixmap = function (dest, data, depth, width, height, pad) {
    var format = this.server.getFormatByDepth(depth)
      , scanline = width + ((format.scanline_pad / format.bpp) - width % (format.scanline_pad / format.bpp));
    switch (depth) {
      case 1:
        var byte;
        for (var row = 0; row < height; row ++) {
          for (var col = 0; col < width; col ++) {
            var data_offset = (row * scanline) + col
              , dest_offset = ((row * width) + col) * 4
              , bit = col % 8
              , bit_mask = Math.pow(2, bit)
            if (bit == 0)
              byte = data.readUInt8(data_offset / 8);
            dest.data[dest_offset    ] =
            dest.data[dest_offset + 1] =
            dest.data[dest_offset + 2] = (byte & bit_mask) ? 0xff : 0x00;
            dest.data[dest_offset + 3] = 0xff;
          }
        }
        break;
      default:
        throw new Error('XYPixmap with depth ' + depth + ' not implemented!');
    }
    return dest;
  }

  XServerClient.prototype.imageToXYPixmap = function (data, depth, width, height) {
    throw new Error('STUB: Implement imageToXYPixmap')
  }

  XServerClient.prototype.imageFromZPixmap = function (dest, data, depth, width, height, pad) {
    var format = this.server.getFormatByDepth(depth)
      , scanline = width + (width % (format.scanline_pad / format.bpp));
    width = scanline; // Overscan the image for now! FIXME: Need to crop instead of overscan!
    switch (depth) {
      case 1:
        throw new Error('1 bit ZPixmap not implemented!');
      default:
        var byte_pp = format.bpp / 8
          , func_pp = 'readUInt' + format.bpp;
        for (var pixel = 0; pixel < data.length / byte_pp; pixel ++) {
          var pixel_data = data[func_pp](pixel * byte_pp)
            , dest_pixel = pixel * 4;
          if (depth === 24) {
            dest.data[(dest_pixel)    ] = (0xff0000 & pixel_data) >> 16;
            dest.data[(dest_pixel) + 1] = (0x00ff00 & pixel_data) >>  8;
            dest.data[(dest_pixel) + 2] = (0x0000ff & pixel_data)      ;
            dest.data[(dest_pixel) + 3] = 0xff;
          }
        }
    }
    return dest;
  }

  XServerClient.prototype.imageToZPixmap = function (from, depth, width, height) {
    var data
      , format = this.server.getFormatByDepth(depth)
      , scanline = width + ((format.scanline_pad / format.bpp) - width % (format.scanline_pad / format.bpp));
    switch (depth) {
      case 1:
        throw new Error('1 bit ZPixmap not implemented!');
      default:
        var byte_pp = format.bpp / 8
          , func_pp = 'writeUInt' + format.bpp
          , data = new EndianBuffer(scanline * height * byte_pp);
        row: for (var y = 0; y < height; y ++)
          col: for (var x = 0; x < scanline; x ++) {
            if (x < width) {
              var offset = ((y * width) + x) * 4;
              data[func_pp](
                  (from.data[offset    ]      ) |
                  (from.data[offset + 1] <<  8) |
                  (from.data[offset + 2] << 16)
                , ((y * scanline) + x) * byte_pp
              );
            }
          }
    }
    return data;
  }

  XServerClient.opcodes = {
      1: 'CreateWindow'
    , 2: 'ChangeWindowAttributes'
    , 3: 'GetWindowAttributes'
    , 4: 'DestroyWindow'
    , 5: 'DestroySubWindows'
    , 6: 'ChangeSaveSet'
    , 7: 'ReparentWindow'
    , 8: 'MapWindow'
    , 9: 'MapSubwindows'
    , 10: 'UnmapWindow'
    , 11: 'UnmapSubwindows'
    , 12: 'ConfigureWindow'
    , 13: 'CirculateWindow'
    , 14: 'GetGeometry'
    , 15: 'QueryTree'
    , 16: 'InternAtom'
    , 17: 'GetAtomName'
    , 18: 'ChangeProperty'
    , 19: 'DeleteProperty'
    , 20: 'GetProperty'
    , 21: 'ListProperties'
    , 22: 'SetSelectionOwner'
    , 23: 'GetSelectionOwner'
    , 24: 'SetSelectionOwner'
    , 25: 'SendEvent'
    , 26: 'GrabPointer'
    , 27: 'UngrabPointer'
    , 28: 'GrabButton'
    , 29: 'UngrabButton'
    , 30: 'ChangeActivePointerGrab'
    , 31: 'GrabKeyboard'
    , 32: 'UngrabKeyboard'
    , 33: 'GrabKey'
    , 34: 'UngrabKey'
    , 35: 'AllowEvents'
    , 36: 'GrabServer'
    , 37: 'UngrabServer'
    , 38: 'QueryPointer'
    , 39: 'GetMotionEvents'
    , 40: 'TranslateCoordinates'
    , 41: 'WarpPointer'
    , 42: 'SetInputFocus'
    , 43: 'GetInputFocus'
    , 44: 'QueryKeymap'
    , 45: 'OpenFont'
    , 46: 'CloseFont'
    , 47: 'QueryFont'
    , 48: 'QueryTextExtents'
    , 49: 'ListFonts'
    , 50: 'ListFontsWithInfo'
    , 51: 'SetFontPath'
    , 52: 'GetFontPath'
    , 53: 'CreatePixmap'
    , 54: 'FreePixmap'
    , 55: 'CreateGC'
    , 56: 'ChangeGC'
    , 57: 'CopyGC'
    , 58: 'SetDashes'
    , 59: 'SetClipRectangles'
    , 60: 'FreeGC'
    , 61: 'ClearArea'
    , 62: 'CopyArea'
    , 63: 'CopyPlane'
    , 64: 'PolyPoint'
    , 65: 'PolyLine'
    , 66: 'PolySegment'
    , 67: 'PolyRectangle'
    , 68: 'PolyArc'
    , 69: 'FillPoly'
    , 70: 'PolyFillRectangle'
    , 71: 'PolyFillArc'
    , 72: 'PutImage'
    , 73: 'GetImage'
    , 74: 'PolyText8'
    , 75: 'PolyText16'
    , 76: 'ImageText8'
    , 77: 'ImageText16'
    , 78: 'CreateColormap'
    , 79: 'FreeColormap'
    , 80: 'CopyColormapAndFree'
    , 81: 'InstallColormap'
    , 82: 'UninstallColormap'
    , 83: 'ListInstalledColormaps'
    , 84: 'AllocColor'
    , 85: 'AllocNamedColor'
    , 86: 'AllocColorCells'
    , 87: 'AllocColorPlanes'
    , 88: 'FreeColors'
    , 89: 'StoreColors'
    , 90: 'StoreNamedColor'
    , 91: 'QueryColors'
    , 92: 'LookupColor'
    , 93: 'CreateCursor'
    , 94: 'CreateGlyphCursor'
    , 95: 'FreeCursor'
    , 96: 'RecolorCursor'
    , 97: 'QueryBestSize'
    , 98: 'QueryExtension'
    , 99: 'ListExtensions'
    , 100: 'ChangeKeyboardMapping'
    , 101: 'GetKeyboardMapping'
    , 102: 'ChangeKeyboardControl'
    , 103: 'GetKeyboardControl'
    , 104: 'Bell'
    , 105: 'ChangePointerControl'
    , 106: 'GetPointerControl'
    , 107: 'SetScreenSaver'
    , 108: 'GetScreenSaver'
    , 109: 'ChangeHosts'
    , 110: 'ListHosts'
    , 111: 'SetAccessControl'
    , 112: 'SetCloseDownMode'
    , 113: 'KillClient'
    , 114: 'RotateProperties'
    , 115: 'ForceScreenSaver'
    , 116: 'SetPointerMapping'
    , 117: 'GetPointerMapping'
    , 118: 'SetModifierMapping'
    , 119: 'GetModifierMapping'
    , 127: 'NoOperation'
  }; // 34 or 127

  XServerClient.prototype.CreateWindow = function (req, callback) {
    var self = this
      , depth = req.data_byte
      , id = req.data.readUInt32(0)
      , parent = this.server.getResource(req.data.readUInt32(4))
      , x = req.data.readInt16(8)
      , y = req.data.readInt16(10)
      , width = req.data.readUInt16(12)
      , height = req.data.readUInt16(14)
      , border_width = req.data.readUInt16(16)
      , _class = req.data.readUInt16(18)
      , visual = req.data.readUInt32(20)
      , vmask = req.data.readUInt32(24)
      , vdata = req.data.slice(28);
    console.log('CreateWindow', id, depth, parent, x, y, width, height);
    var window = this.server.putResource(new x_types.Window(this, id, depth, x, y, width, height, border_width, _class, visual, vmask, vdata));
    window.parent = parent;
    callback();
  }

  XServerClient.prototype.ChangeWindowAttributes = function (req, callback) {
    var window = this.server.getResource(req.data.readUInt32(0), x_types.Window)
      , rep = new x_types.Reply(req)
      , vmask = req.data.readUInt32(4)
      , vdata = req.data.slice(8);
    vdata.endian = this.endian;
    window.changeData(this, vmask, vdata);
    callback();
  }

  XServerClient.prototype.GetWindowAttributes = function (req, callback) {
    var window = this.server.getResource(req.data.readUInt32(0), x_types.Window)
      , rep = new x_types.Reply(req);
    rep.data_byte = 2; // Backing store (0 NotUseful, 1 WhenMapper, 2 Always)
    rep.data.writeUInt32(0, 0); // Visual id
    rep.data.writeUInt16((!window.input_output) + 1, 4); // Class (1 InputOutput, 2 InputOnly)
    rep.data.writeUInt8(0, 6); // Bit gravity
    rep.data.writeUInt8(window.win_gravity, 7); // Win gravity
    rep.data.writeUInt32(0, 8); // Backing planes
    rep.data.writeUInt32(window.background_pixel || 0, 12); // Backing pixel
    rep.data.writeUInt8(0, 16); // Save under
    rep.data.writeUInt8(window.isMapped() ? 1 : 0, 17); // Map is installed
    rep.data.writeUInt8(window.isMapped() ? 2 : 0, 18); // Map state (0 Unmapped, 1 Unviewable, 2 Viewable)
    rep.data.writeUInt8(window.override_redirect, 19); // Override redirect
    rep.data.writeUInt32((this._colormap && this._colormap.id) || 0, 20); // Colormap
    rep.data_extra.push(new x_types.UInt32(window.event_mask)); // All event masks
    rep.data_extra.push(new x_types.UInt32(window.event_mask)); // Your event mask
    rep.data_extra.push(new x_types.UInt16(window.do_not_propagate_mask)); // Do not propagate mask
    rep.data_extra.push(new x_types.UInt16(0)); // Unused
    callback(null, rep);
  }
  
  XServerClient.prototype.DestroyWindow = function (req, callback) {
    var window = this.server.getResource(req.data.readUInt32(0), x_types.Window);
    if (window !== window.owner.server.root)
      window.destroy();
    callback();
  }

  XServerClient.prototype.DestroySubWindows = function (req, callback) {
    var window = this.server.getResource(req.data.readUInt32(0), x_types.Window);
    window.children.forEach(function (child) {
      child.destroy();
    });
    callback();
  }

  XServerClient.prototype.ChangeSaveSet = function (req, callback) {
    var window = this.server.getResource(req.data.readUInt32(0), x_types.Window);
    if (req.data_byte) {
      delete this.save_set[this.save_set.indexOf(window)];
    } else {
      this.save_set.push(window);
    }
    callback();
  }

  XServerClient.prototype.ReparentWindow = function (req, callback) {
    var window = this.server.getResource(req.data.readUInt32(0), x_types.Window)
      , parent = this.server.getResource(req.data.readUInt32(4))
      , x = req.data.readInt16(8)
      , y = req.data.readInt16(10)
      , was_mapped = window.isMapped();
    console.log('ReparentWindow', window.id, window.parent.id, parent.id);
    window.unmap();
    window.x = x;
    window.y = y;
    window.triggerEvent('ReparentNotify', { new_parent: parent })
    window.parent = parent;
    window.element.appendTo(parent.element.children());
    window.triggerEvent('ReparentNotify', { new_parent: parent })
    if (was_mapped)
      window.map();
    callback();
  }

  XServerClient.prototype.MapWindow = function (req, callback) {
    var self = this
      , window = this.server.getResource(req.data.readUInt32(0), x_types.Window);
    console.log('MapWindow', window.id);
    reps = [];
    if (
      (~ window.parent.events.indexOf('SubstructureRedirect')) &&
      Object.keys(window.parent.event_clients).filter(function (id) { return ~ window.parent.event_clients[id].indexOf('SubstructureRedirect') && id != self.id }).length &&
      ! window.override_redirect
    ) {
      xt = x_types;
      window.parent.triggerEvent(new x_types.events.map.MapRequest(window, {}));
      console.log('!REDIRECT!');
    } else
    if (window.map()) {
      window.triggerEvent('Expose', { count: 0 });
    }
    callback(null, reps);
  }

  XServerClient.prototype.MapSubwindows = function (req, callback) {
    var window = this.server.getResource(req.data.readUInt32(0), x_types.Window);
    console.log('MapSubwindows', window.id);
    var reps = [];
    function run (parent_children) {
      var children_children = [];
      parent_children.forEach(function (child_window, i) {
        if (child_window.map()) {
          child_window.triggerEvent('MapNotify')
          child_window.triggerEvent('Expose', { count: 0 });
        }
        children_children.splice.apply(children_children, [0, 0].concat(child_window.children));
      });
      if (children_children.length)
        run(children_children);
    }
    run(window.children);
    callback(null, reps);
  }

  XServerClient.prototype.UnmapWindow = function (req, callback) {
    var window = this.server.getResource(req.data.readUInt32(0), x_types.Window);
    console.log('UnmapWindow');
    window.unmap()
    callback();
  }
  
  XServerClient.prototype.UnmapSubwindows = function (req, callback) {
    var window = this.server.getResource(req.data.readUInt32(0), x_types.Window);
    console.log('UnmapSubwindows');
    window.children.forEach(function (child) {
      child.unmap();
    });
    callback();
  }

  var _win_configure_vfields = [
    'x', 'y', 'width', 'height', 'border_width', 'sibling', 'stack_mode'
  ]
  XServerClient.prototype.ConfigureWindow = function (req, callback) {
    var window = this.server.getResource(req.data.readUInt32(0), x_types.Window)
      , vmask = req.data.readUInt16(4)
      , vdata = req.data.slice(8);
    vdata.endian = this.endian;
    var offset = 0;
    window.sibling = null;
    for (var i = 0; i < _win_configure_vfields.length; i++)
      if (vmask & Math.pow(2, i))
        window[_win_configure_vfields[i]] = vdata.readUInt32((offset ++) * 4);
    console.log('ConfigureWindow FIXME: Incomplete');
    callback();
  }

  XServerClient.prototype.GetGeometry = function (req, callback) {
    var drawable = this.server.getResource(req.data.readUInt32(0), x_types.Drawable)
      , rep = new x_types.Reply(req);
    rep.data_byte = drawable.depth;

    rep.data.writeUInt32(drawable.getRoot().id, 0);
    rep.data.writeInt16(drawable.x, 4);
    rep.data.writeInt16(drawable.y, 6);
    rep.data.writeInt16(drawable.width, 8);
    rep.data.writeInt16(drawable.height, 10);
    // TODO: 2 byte border-geom
    callback(null, rep);
  }

  XServerClient.prototype.QueryTree = function (req, callback) {
    var window = this.server.getResource(req.data.readUInt32(0), x_types.Window)
      , rep = new x_types.Reply(req);
    rep.data.writeUInt32(window.getRoot(), 0);
    rep.data.writeUInt32((window.parent && window.parent.id) || 0, 4);
    rep.data.writeUInt16(window.children.length, 8);
    window.children.forEach(function (child) {
      rep.data_extra.push(new x_types.UInt32(child.id));
    });
    callback(null, rep);
  }

  XServerClient.prototype.InternAtom = function (req, callback) {
    var only_if_exists = req.data_byte
      , length = req.data.readUInt16(0)
      , name = req.data.toString('ascii', 4, 4 + length)
      , index = this.server.atoms.indexOf(name) + 1;
    if ((!index) && ! only_if_exists)
      index = this.server.atoms.push(name);
    var rep = new x_types.Reply(req)
    rep.data.writeUInt32(index, 0);
    callback(null, rep);
  }

  XServerClient.prototype.GetAtomName = function (req, callback) {
    this.server.getAtom(req.data.readUInt32(0));
    var rep = new x_types.Reply(req);
    rep.data.writeUInt16(atom.length);
    rep.data_extra.push(new x_types.String(atom));
    callback(null, rep);
  }

  XServerClient.prototype.ChangeProperty = function (req, callback) {
    var mode = req.data_byte
      , window = this.server.getResource(req.data.readUInt32(0), x_types.Window)
      , atom = req.data.readUInt32(4)
      , property = this.server.atoms[atom - 1]
      , type = req.data.readUInt32(8)
      , format = req.data.readUInt8(12)
      , length = req.data.readUInt32(16) * (format === 8 ? 1 : (format === 16 ? 2 : (format === 32) ? 4 : 0))
      , data = req.data.slice(20, length + 20);
    data.endian = this.endian;
    console.log('ChangeProperty', window, req.data.readUInt32(0))
    window.changeProperty(atom, property, format, type, data, mode);
    //console.log('ChangeProperty', window.id, property, format, data, mode);
    callback();
  }

  XServerClient.prototype.DeleteProperty = function (req, callback) {
    var window = this.server.getResource(req.data.readUInt32(0), x_types.Window)
      , atom = req.data.readUInt32(4)
      , property = this.server.atoms[atom - 1];

    window.deleteProperty(property);
    //console.log('DeleteProperty', window.id, property);

    window.triggerEvent('PropertyNotify', { atom: atom, deleted: true });
    callback();
  }


  XServerClient.prototype.GetProperty = function (req, callback) {
    var window = this.server.getResource(req.data.readUInt32(0), x_types.Window)
      , atom = req.data.readUInt32(4)
      , property = this.server.atoms[atom - 1]
      , type = req.data.readUInt32(8)
      , long_off = req.data.readUInt32(12)
      , long_len = req.data.readUInt32(16)
      , rep = new x_types.Reply(req);

    //console.log('Get Property', window.id, property);

    var value = window.getProperty(property);
    if (!value)
      return callback(null, rep);

    rep.data_byte = value.format;
    rep.data.writeUInt32(value.type || 0, 0);
    rep.data.writeUInt32(value.length || 0, 4);
    console.log(value.length / (value.format / 8));
    rep.data.writeUInt32(value.length / (value.format / 8), 8);
    rep.data_extra.push(new x_types.DataBuffer(value));
    callback(null, rep);
  }

  XServerClient.prototype.ListProperties = function (req, callback) {
    var self = this
      , window = this.server.getResource(req.data.readUInt32(0), x_types.Window)
      , rep = new x_types.Reply(req)
      , atoms = Object.keys(window.properties).map(function (name) { return self.atoms.indexOf(name) + 1 });
    rep.data.writeUInt16(atoms.length, 0);

    atoms.forEach(function (atom) {
      rep.data_extra.push(new x_types.UInt32(atom));
    });

    callback(null, rep);
  }

  XServerClient.prototype.GetSelectionOwner = function (req, callback) {
    var atom_id = req.data.readUInt32(0)
      , atom = this.server.atoms[atom_id]
      , owner = this.server.atom_owners[atom_id]
      , rep = new x_types.Reply(req);
    rep.data.writeUInt32((owner && this.server.getResource(owner) && owner) || 0)
    callback(null, rep);
  }

  XServerClient.prototype.SendEvent = function (req, callback) {
    var propagate = req.data_byte
      , wid = req.data.readUInt32(0)
      , window = this.server.getResource(req.data.readUInt32(0), x_types.Window)
      , event_mask = req.data.readUInt32(4)
      , event = x_types.events.fromBuffer(this, req.data, 8);
    if (! event)
      throw new Error('SendEvent sent an unknown event');
    window.sendEvent(event, event_mask);
    callback();
  }

  XServerClient.prototype.GrabPointer = function (req, callback) {
    var window = this.server.getResource(req.data.readUInt32(0), x_types.Window)
      , owner_events = req.data_byte
      , events = req.data.readUInt16(4)
      , mouse_async = req.data.readUInt8(6)
      , keybd_async = req.data.readUInt8(7)
      , confine = this.server.getResource(req.data.readUInt32(8))
      , cursor = req.data.readUInt32(12)
      , timestamp = req.data.readUInt32(16)
      , rep = new x_types.Reply(req);

    if (this.server.grab_pointer) {
      rep.data_byte = 1;
    } else if (! window.isMapped()) {
      rep.data_byte = 3;
    } else {
      var root = window.getRoot();
      if (cursor) {
        var cursor_class = 'cursor_' + cursor + '_important';
        root.element
          .addClass(cursor_class).data('grab_pointer_class', cursor_class);
      }
      var event_filter = root.element.parent().parent().parent();
      event_filter.addClass('grab_pointer');
      if (owner_events)
        event_filter.addClass('owner_events');
      this.server.grab_pointer = window;
      this.server.grab_pointer_owner_events = owner_events;
      this.server.grab_pointer_mask = window.processEventMask(events);
      rep.data_byte = 0;
    }
    console.log('GrabPointer', window, owner_events, events, mouse_async, keybd_async, confine, timestamp);
    callback(null, rep);
  }

  XServerClient.prototype.UngrabPointer = function (req, callback) {
    var time = req.data.readUInt32(0);
    if (this.server.grab_pointer) {
      this.server.grab_pointer = null;
      var cursor = this.server.root.element.data('grab_pointer_class');
      if (cursor)
        this.server.root.element.removeClass(cursor);
      this.server.root.element.parent().parent().parent().removeClass('grab_pointer');
    }
    callback();
  }
  
  XServerClient.prototype.GrabKeyboard = function (req, callback) {
    var window = this.server.getResource(req.data.readUInt32(0))
      , owner_events = req.data_byte
      , timestamp = req.data.readUInt32(4)
      , mouse_async = req.data.readUInt8(8)
      , keybd_async = req.data.readUInt8(9)
      , rep = new x_types.Reply(req);

    if (this.server.grab_pointer) {
      rep.data_byte = 1;
    } else if (! window.isMapped()) {
      rep.data_byte = 3;
    } else {
      var root = window.getRoot();
      root.element.parent().parent().parent().addClass('grab_keyboard');
      this.server.grab_keyboard = window;
      rep.data_byte = 0;
    }
    console.log('GrabKeyboard', window, owner_events, timestamp, mouse_async, keybd_async);
    callback(null, rep);
  }
  
  XServerClient.prototype.UngrabKeyboard = function (req, callback) {
    var time = req.data.readUInt32(0);
    if (this.server.grab_keyboard) {
      this.server.grab_keyboard = null;
      this.server.root.element.parent().parent().parent().removeClass('grab_keyboard');
    }
    callback();
  }

  XServerClient.prototype.GrabServer = function (req, callback) {
    this.server.grab = this;
    this.server.grab_reason = 'GrabServer';
    callback();
  }

  XServerClient.prototype.UngrabServer = function (req, callback) {
    this.server.grab = null;
    this.server.flushGrabBuffer();
    callback();
  }

  XServerClient.prototype.QueryPointer = function (req, callback) {
    var window = this.server.getResource(req.data.readUInt32(0), x_types.Window)
      , rep = new x_types.Reply(req);
    rep.data.writeUInt32(0x26, 0);
    rep.data.writeUInt32(0, 4);
    rep.data.writeUInt16(this.server.mouseX, 8);
    rep.data.writeUInt16(this.server.mouseY, 10);
    rep.data.writeUInt16(this.server.mouseX - window.x, 12);
    rep.data.writeUInt16(this.server.mouseY - window.y, 14);
    callback(null, rep);
  }

  XServerClient.prototype.SetInputFocus = function (req, callback) {
    var revert = req.data_byte
      , window = this.server.getResource(req.data.readUInt32(0), x_types.Window, 0, 1)
      , time = req.data.readUInt32(4) || ~~(Date.now() / 1000);
    if (time < this.server.input_focus_time)
      return;
    switch (window) {
      case 0:
        this.server.input_focus = null;
      break;
      case 1:
        this.server.input_focus = this.server.root;
      break;
      default:
        this.server.input_focus = window;
    }
    this.server.input_focus_time = time;
    this.server.input_focus_revert = revert;
    callback();
  }

  XServerClient.prototype.GetInputFocus = function (req, callback) {
    var rep = new x_types.Reply(req);
    rep.data_byte = this.server.input_focus_revert;
    rep.data.writeUInt32(
        (this.server.input_focus === this.server.root ? 1 : this.server.input_focus) || 0
      , 0
    );
    callback(null, rep);
  }

  XServerClient.prototype.OpenFont = function (req, callback) {
    var fid = req.data.readUInt32(0)
      , length = req.data.readUInt16(4)
      , name = req.data.toString('ascii', 8, length + 8);
    this.server.grab = this;
    this.server.grab_reason = 'OpenFont';
    this.server.openFont(this, fid, name);
    callback();
  }

  XServerClient.prototype.QueryFont = function (req, callback) {
    var font = this.server.getResource(req.data.readUInt32(0), x_types.Font);
    var rep = new x_types.Reply(req);
    rep.data = new EndianBuffer(32);
    rep.data.endian = req.data.endian;
    font.getChar(-1).toCharInfo().writeBuffer(rep.data,  0); // Write min bounds
    font.getChar(-2).toCharInfo().writeBuffer(rep.data, 16); // Write max bounds
    // Extra data
    rep.data_extra.push(font.toFontInfo());
    rep.data_extra.push(new x_types.UInt32(font.characters.length));
    for (var i in font.properties) {
      if (typeof font.properties[i] === 'string') {
        // Convert string properties to atoms
        font.properties[i] = this.server.atoms.push(font.properties[i]);
      }
      rep.data_extra.push(new x_types.FontProp(
          this.server.atoms.indexOf(i) + 1
        , font.properties[i]
      ));
    }
    for (var i = 0; i < font.characters.length; i++)
      rep.data_extra.push(font.getChar(i).toCharInfo());
    callback(null, rep);
  }

  XServerClient.prototype.ListFonts = function (req, callback) {
    var max_names = req.data.readUInt16(0)
      , pattern_length = req.data.readUInt16(2)
      , pattern = req.data.toString('ascii', 4, 4 + pattern_length)
      , fonts = this.server.listFonts(pattern).slice(0, max_names);

    var rep = new x_types.Reply(req);
    rep.data.writeUInt16(fonts.length);
    fonts.forEach(function (font) {
      rep.data_extra.push(new x_types.XString(font));
    });
    callback(null, rep);
  }

  XServerClient.prototype.ListFontsWithInfo = function (req, callback) {
    var max_names = req.data.readUInt16(0)
      , pattern_length = req.data.readUInt16(2)
      , pattern = req.data.toString('ascii', 4, 4 + pattern_length)
      , fonts = this.server.listFonts(pattern).slice(0, max_names);
    console.log('ListFontsWithInfo', pattern);
    if (!fonts.length) {
      var rep = new x_types.Reply(req);
      rep.data_extra.push(new x_types.Nulls(7 * 4));
      return callback(null, rep);
    }
    async.map(
        fonts
      , function (font_name, callback) {
          var resolved_name = this.server.resolveFont(font_name);
          if (resolved_name[1])
            return this.server.loadFont(resolved_name[1], resolved_name[0], callback);
          console.log('Not loading invalid name');
          callback('Not resolved');
        }
      , function (err, fonts) {
          fonts = fonts.filter(function (font) { return font && !font.error });
          this.server.grab = false;
          this.server.flushGrabBuffer();
          var reps = fonts.map(function (font) {
            var rep = new x_types.Reply(req);
            rep.data = new EndianBuffer(32);
            rep.data.endian = req.data.endian;
            rep.data_byte = font.name.length;
            font.getChar(-1).toCharInfo().writeBuffer(rep.data, 0);
            font.getChar(-2).toCharInfo().writeBuffer(rep.data, 16);
            // Extra data
            rep.data_extra.push(font.toFontInfo());
            rep.data_extra.push(new x_types.UInt32(fonts.length));
            for (var i in font.properties)
              rep.data_extra.push(new x_types.FontProp(
                  this.server.atoms.indexOf(i)
                , font.properties[i]
              ));
            rep.data_extra.push(new x_types.String(font.name));
            return rep;
          }.bind(this));
          var rep = new x_types.Reply(req);
          rep.data_extra.push(new x_types.Nulls(7 * 4));
          reps.push(rep);
          callback(null, reps);
        }.bind(this)
    );
  }

  XServerClient.prototype.CreatePixmap = function (req, callback) {
    var pid = req.data.readUInt32(0)
      , drawable = this.server.getResource(req.data.readUInt32(4), x_types.Drawable)
      , depth = req.data_byte
      , width = req.data.readUInt16(8)
      , height = req.data.readUInt16(10);
    console.log('CreatePixmap', depth, pid, drawable, width, height);
    if (drawable.depth !== depth && depth !== 1) {
      throw new x_types.Error(req, 4, depth);
    }
    this.server.putResource(new x_types.Pixmap(this, pid, depth, drawable, width, height));
    callback();
  }

  XServerClient.prototype.FreePixmap = function (req, callback) {
    this.server.freeResource(req.data.readUInt32(0), x_types.Pixmap);
    callback();
  }

  XServerClient.prototype.CreateGC = function (req, callback) {
    var cid = req.data.readUInt32(0)
      , drawable = this.server.getResource(req.data.readUInt32(4), x_types.Drawable)
      , vmask = req.data.readUInt32(8)
      , vdata = req.data.slice(12);
    console.log(this, cid, drawable, vmask, vdata);
    this.server.putResource(new x_types.GraphicsContext(this, cid, drawable, vmask, vdata));
    callback();
  }

  XServerClient.prototype.ChangeGC = function (req, callback) {
    var gc = this.server.getResource(req.data.readUInt32(0), x_types.GraphicsContext)
      , vmask = req.data.readUInt32(4)
      , vdata = req.data.slice(8);
    gc.changeData(this, vmask, vdata);
    callback();
  }

  XServerClient.prototype.ClearArea = function (req, callback) {
    var window = this.server.getResource(req.data.readUInt32(0), x_types.Window)
      , x = req.data.readUInt16(4)
      , y = req.data.readUInt16(6)
      , w = req.data.readUInt16(8) || (window.width - y)
      , h = req.data.readUInt16(10) || (window.height - x);
    var context = window.canvas[0].getContext('2d');
    context.clearRect(x, y, w, h);
    if (req.data_byte)
      window.triggerEvent('Expose', { x: x, y: y, width: w, height: h });
    callback();
  }

  XServerClient.prototype.CopyArea = function (req, callback) {
    var src    = this.server.getResource(req.data.readUInt32( 0), x_types.Drawable)
      , dst    = this.server.getResource(req.data.readUInt32( 4), x_types.Drawable)
      , gc     = this.server.getResource(req.data.readUInt32( 8), x_types.GraphicsContext)
      , src_x  = req.data.readInt16 (12)
      , src_y  = req.data.readInt16 (14)
      , dst_x  = req.data.readInt16 (16)
      , dst_y  = req.data.readInt16 (18)
      , width  = req.data.readUInt16(20)
      , height = req.data.readUInt16(22)
      , data   = src.getImageData(src_x, src_y, width, height);
    console.log('CopyArea', src.id, dst.id, src_x, src_y, dst_x, dst_y, width, height);
    dst.putImageData(data, dst_x, dst_y);
    if (gc.graphics_exposures)
      dst.owner.sendEvent(new x_types.events.map.NoExposure(dst, { major: req.opcode, minor: 0 }));
    callback();
  }

  XServerClient.prototype.FreeGC = function (req, callback) {
    this.server.freeResource(req.data.readUInt32(0), x_types.GraphicsContext);
    callback();
  }

  XServerClient.prototype.PolyLine = function (req, callback) {
    var drawable = this.server.getResource(req.data.readUInt32(0), x_types.Drawable)
      , coord_mode = req.data_byte
      , gc = this.server.getResource(req.data.readUInt32(4), x_types.GraphicsContext)
      , context = gc.getContext(drawable)
      , count = req.length_quad - 3;
    context.moveTo(0, 0);
    var prev_x = 0, prev_y = 0;
    for (var i = 8; i < 8 + (count * 4); i += 4) {
      var x = (coord_mode ? prev_x : 0) + req.data.readInt16(i)
        , y = (coord_mode ? prev_y : 0) + req.data.readInt16(i + 2)
      if (i === 8)
        context.moveTo(x, y);
      else
        context.lineTo(x, y);
      context.stroke();
      prev_x = x;
      prev_y = y;
    }
    callback();
  }

  XServerClient.prototype.PolySegment = function (req, callback) {
    var drawable = this.server.getResource(req.data.readUInt32(0), x_types.Drawable)
      , gc = this.server.getResource(req.data.readUInt32(4), x_types.GraphicsContext)
      , context = gc.getContext(drawable)
      , count = (req.length_quad - 3) / 2;
    for (var i = 8; i < ((count + 1) * 8); i += 8) {
      var x1 = req.data.readInt16(i)
        , y1 = req.data.readInt16(i + 2)
        , x2 = req.data.readUInt16(i + 4)
        , y2 = req.data.readUInt16(i + 6);
      context.beginPath();
      context.moveTo(x1, y1);
      context.lineTo(x2, y2);
      context.stroke();
    }
    callback();
  }

  XServerClient.prototype.PolyRectangle = function (req, callback) {
    var drawable = this.server.getResource(req.data.readUInt32(0), x_types.Drawable)
      , gc = this.server.getResource(req.data.readUInt32(4), x_types.GraphicsContext)
      , context = gc.getContext(drawable)
      , count = (req.length_quad - 3) / 2;
    // x, y, width, height
    for (var i = 8; i < ((count + 1) * 8); i += 8) {
      var x = req.data.readInt16(i)
        , y = req.data.readInt16(i + 2)
        , w = req.data.readUInt16(i + 4)
        , h = req.data.readUInt16(i + 6);
      context.beginPath();
      context.rect(x, y, w, h);
      context.stroke();
    }
    callback();
  }

  XServerClient.prototype.FillPoly = function (req, callback) {
    var drawable = this.server.getResource(req.data.readUInt32(0), x_types.Drawable)
      , gc = this.server.getResource(req.data.readUInt32(4), x_types.GraphicsContext)
      , context = gc.getContext(drawable)
      , shape = req.data.readUInt8(8)
      , coordinate_mode = req.data.readUInt8(9)
      , length = (req.length_quad - 4) * 4
      , coordinates = [];
    // Unused 2
    // 12
    if (coordinate_mode != 0)
      throw new Error('Previous coordinate mode not implemented');
    for (var i = 12; i < length + 12; i += 4)
      coordinates.push([req.data.readUInt16(i), req.data.readUInt16(i + 2)]);

    context.beginPath();
    coordinates.forEach(function (coord, i) {
      if (i == 0 && coordinate_mode == 0) {
        context.moveTo(coord[0], coord[1]);
      } else {
        context.lineTo(coord[0], coord[1]);
      }
    });
//    context.closePath()
    context.fill();

    console.log('FillPoly', drawable, context, coordinates);
    callback();
  }

  XServerClient.prototype.PolyFillRectangle = function (req, callback) {
    var drawable = this.server.getResource(req.data.readUInt32(0), x_types.Drawable)
      , gc = this.server.getResource(req.data.readUInt32(4), x_types.GraphicsContext)
      , context = gc.getContext(drawable)
      , count = (req.length_quad - 3) / 2;
    // x, y, width, height
    for (var i = 8; i < ((count + 1) * 8); i += 8) {
      var x = req.data.readInt16(i)
        , y = req.data.readInt16(i + 2)
        , w = req.data.readUInt16(i + 4)
        , h = req.data.readUInt16(i + 6);
      context.beginPath();
      context.rect(x, y, w, h);
      context.fill();
    }
    if (gc.clip_mask) {
      gc.globalCompositeOperation = 'xor';
      //context.drawImage(gc.clip_mask.canvas[0], gc.clip_x_origin || 0, gc.clip_y_origin || 0);
    }
    callback();
  }

  XServerClient.prototype.PolyFillArc = function (req, callback) {
    var drawable = this.server.getResource(req.data.readUInt32(0), x_types.Drawable)
      , d_w = drawable.canvas[0].width
      , d_h = drawable.canvas[0].height
      , gc = this.server.getResource(req.data.readUInt32(4), x_types.GraphicsContext)
      , context = gc.getContext(drawable)
      , count = (req.length_quad - 3) / 3
      , end = (count * 12) + 8;
    for (var i = 8; i < end; i += 12) {
      var x = req.data.readInt16 (i)
        , y = req.data.readInt16 (i + 2)
        , w = req.data.readUInt16(i + 4)
        , h = req.data.readUInt16(i + 6)
        , aspect = w / h
        , s = (req.data.readInt16 (i + 8) / 64) + 90 // Arc starts at 3 o'clock and each degree is expressed as 64
        , sr = (s * Math.PI) / 180
        , e = (req.data.readInt16 (i + 10) / 64) + s // This is the arc extent, not finishing point
        , er = (e * Math.PI) / 180;

      context.save();
      context.scale(aspect, 1);
      context.beginPath();
      context.arc((x + (w / 2)) / aspect, y + (h / 2), h / 2, sr, er);
      context.restore();
      context.fill();
    }
    callback();
  }

  var _image_formats = ['Bitmap', 'XYPixmap', 'ZPixmap'];
  XServerClient.prototype.PutImage = function (req, callback) {
    var format = _image_formats[req.data_byte]
      , drawable = this.server.getResource(req.data.readUInt32(0), x_types.Drawable)
      , context = this.server.getResource(req.data.readUInt32(4), x_types.GraphicsContext)
      , width = req.data.readUInt16(8)
      , height = req.data.readUInt16(10)
      , x = req.data.readInt16(12)
      , y = req.data.readInt16(14)
      , pad = req.data.readUInt8(16)
      , depth = req.data.readUInt8(17)
      , data = req.data.slice(20);
    data.endian = this.endian;
    context.putImage(drawable, format, data, width, height, x, y, pad, depth);
    console.log(format, width, height, x, y, pad, depth);
    callback();
  }

  XServerClient.prototype.GetImage = function (req, callback) {
    var format = _image_formats[req.data_byte]
      , drawable = this.server.getResource(req.data.readUInt32(0), x_types.Drawable)
      , x = req.data.readInt16(4)
      , y = req.data.readInt16(6)
      , w = req.data.readUInt16(8)
      , h = req.data.readUInt16(10)
      , plane_mask = req.data.readUInt32(12)
      , rep = new x_types.Reply(req);

    console.log('GetImage', drawable.id, drawable.element.slice());

    rep.data_byte = drawable.depth;
    rep.data_extra.push(
      new x_types.DataBuffer(
        this['imageTo' + format](drawable.getImageData(x, y, w, h), drawable.depth, w, h)
      )
    );
    callback(null, rep);
    console.log('FIXME GetImage:', format, drawable, x, y, w, h, plane_mask);
  }

  XServerClient.prototype.PolyText8 = function (req, callback) {
    var drawable = this.server.getResource(req.data.readUInt32(0), x_types.Drawable)
      , gc = this.server.getResource(req.data.readUInt32(4), x_types.GraphicsContext)
      , context = gc.getContext(drawable)
      , count = (req.length_quad / 4) - 1
      , x = req.data.readInt16(8)
      , y = req.data.readInt16(10)// - gc.font.font.getChar(-1).ascent
      , textitems = []
      , req_offset = 12;
    for (var i = 0; i < count; i ++) {
      var len = req.data.readUInt8(req_offset);
      if (len === 0)
        break;
      if (len === 255)
        throw new Error('Type 255');
      else {
        var delta = req.data.readInt8(req_offset + 1)
          , start = req_offset + 2
          , end = req_offset + 2 + len
          , str = req.data.toString('ascii', start, end);
        context.fillText(str, x + delta, y)
        x += context.measureText(str).width + delta;
//        x += gc.font.font.drawTo(str, gc.getContext(drawable), x + delta, y, 255, 255, 255);
        req_offset = end + ((end % 4) ? (4 - (end % 4)) : 0);
        if (req_offset + 4 >= req.data.length)
          break;
      }
    }
    callback();
  }

  XServerClient.prototype.PolyText16 = function (req, callback) {
    var drawable = this.server.getResource(req.data.readUInt32(0), x_types.Drawable)
      , gc = this.server.getResource(req.data.readUInt32(4), x_types.GraphicsContext)
      , context = gc.getContext(drawable)
      , count = (req.length_quad - 1) / 4
      , x = req.data.readInt16(8)
      , y = req.data.readInt16(10)// - gc.font.font.getChar(-1).ascent
      , textitems = []
      , req_offset = 12;
    for (var i = 0; i < count; i ++) {
      var len = req.data.readUInt8(req_offset);
      if (len === 0)
        break;
      if (len === 255)
        throw new Error('Type 255');
      else {
        var delta = req.data.readInt8(req_offset + 1)
          , start = req_offset + 2
          , end = req_offset + 2 + (len * 2)
          , str = this.server.encodeString(req.data.toString('2charb', start, end));
        context.fillText(str, x + delta, y);
        x += context.measureText(str).width + delta;
//        x += gc.font.font.drawTo(str, gc.getContext(drawable), x + delta, y, 255, 255, 255);
        req_offset = end + ((end % 4) ? (4 - (end % 4)) : 0);
        if (req_offset + 4 >= req.data.length)
          break;
      }
    }
    callback();
  }

  XServerClient.prototype.AllocColor = function (req, callback) {
    var cmap = this.server.getResource(req.data.readUInt32(0), x_types.ColorMap)
      , r = req.data.readUInt16(4) >> 8
      , g = req.data.readUInt16(6) >> 8
      , b = req.data.readUInt16(8) >> 8
      , rep = new x_types.Reply(req);
    rep.data.writeUInt16(r, 0);
    rep.data.writeUInt16(g, 2);
    rep.data.writeUInt16(b, 4);
    rep.data.writeUInt32( (r << 16) | (g << 8) | b, 8);
    callback(null, rep);
  }

  XServerClient.prototype.QueryColors = function (req, callback) {
    console.log('QueryColors');
    var count = req.length_quad - 2
      , length = count * 4
      , colormap = this.server.getResource(req.data.readUInt32(0), x_types.ColorMap)
      , rep = new x_types.Reply(req);
    rep.data.writeUInt16(count);
    for (var i = 4; i < length + 4; i += 4) {
      var rgb = colormap.getRGB(req.data.readUInt32(i));
      rep.data_extra.push(new x_types.UInt16(rgb[0] < 8));
      rep.data_extra.push(new x_types.UInt16(rgb[1] < 8));
      rep.data_extra.push(new x_types.UInt16(rgb[2] < 8));
      rep.data_extra.push(new x_types.UInt16(0));
    }
    callback(null, rep);
  }


  XServerClient.prototype.LookupColor = function (req, callback) {
    var cmap = this.server.getResource(req.data.readUInt32(0), x_types.ColorMap)
      , length = req.data.readUInt16(4)
      , name = req.data.toString('ascii', 8, length + 8)
      , color = rgb_colors[name] || 0
      , rep = new x_types.Reply(req);

    rep.data.writeUInt16((color & 0xff0000) >> 16,  0);
    rep.data.writeUInt16((color & 0x00ff00) >>  8,  2);
    rep.data.writeUInt16((color & 0x0000ff) >>  0,  4);
    rep.data.writeUInt16((color & 0xff0000) >> 16,  6);
    rep.data.writeUInt16((color & 0x00ff00) >>  8,  8);
    rep.data.writeUInt16((color & 0x0000ff) >>  0, 10);

    callback(null, rep);
  }

  XServerClient.prototype.CreateGlyphCursor = function (req, callback) {
    var cursor_id = req.data.readUInt32(0)
      , source_font = this.server.getResource(req.data.readUInt32(4), x_types.Font)
      , mask_font = this.server.getResource(req.data.readUInt32(8), x_types.Font)
      , source_char = req.data.readUInt16(12)
      , mask_char = req.data.readUInt16(14)
      , source_char_meta = source_font && source_char && source_font.characters[source_char]
      , mask_char_meta = mask_font && mask_char && mask_font.characters[mask_char]
      , fore_r = req.data.readUInt16(16)
      , fore_g = req.data.readUInt16(18)
      , fore_b = req.data.readUInt16(20)
      , back_r = req.data.readUInt16(22)
      , back_g = req.data.readUInt16(24)
      , back_b = req.data.readUInt16(26)
      , width = Math.max(
            source_font && source_char_meta.width
          , mask_font && mask_char_meta.width
        )
      , height = Math.max(
            source_font && source_char_meta.height
          , mask_font && mask_char_meta.height
        )
      , x = Math.max(
            source_font && (0 - source_char_meta.left)
          , mask_font   && (0 - mask_char_meta.left)
        )
      , y = Math.max(
            source_font && (source_char_meta.ascent)
          , mask_font   && (mask_char_meta.ascent)
        );
    var canvas = $('<canvas />').attr('width', width).attr('height', height)[0]
      , context = canvas.getContext('2d');
    $('.buffers').append(canvas);
    context.save();
    if (mask_char) {
      var color = (
          ((~~(back_r / 0x100)) << 16) +
          ((~~(back_g / 0x100)) << 8 ) +
          ((~~(back_b / 0x100)) << 0 )
        ).toString(16)
      color = (new Array(7 - color.length)).join(0) + color;
      context.fillStyle = '#' + color;
      context.font = '30px "' + mask_font.file_name + '"';
      context.fillText(
          this.server.encodeString(String.fromCharCode(mask_char))
        , x
        , y
      );
    }
//      mask_char.drawTo(context, x, y, back_r, back_g, back_b);
    var color = (
        ((~~(fore_r / 0x100)) << 16) +
        ((~~(fore_g / 0x100)) << 8 ) +
        ((~~(fore_b / 0x100)) << 0 )
      ).toString(16)
    color = (new Array(7 - color.length)).join(0) + color;
    context.fillStyle = '#' + color;
    if (source_font !== mask_font)
      context.font = '30px "' + source_font.file_name + '"';
    context.fillText(
        this.server.encodeString(String.fromCharCode(source_char))
      , x
      , y
    );
//    source_char.drawTo(context, x, y, fore_r, fore_g, fore_b);
    canvas.id = cursor_id;
    context.restore();
    $('style#cursors')[0].innerHTML += [
      , '.cursor_' , cursor_id , ' { '
      ,   'cursor: url(' , canvas.toDataURL() , ') ' , x , ' ' , y , ', default;'
      , '}'
      , '.cursor_' , cursor_id , ':active { '
      ,   'cursor: url(' , canvas.toDataURL() , ') ' , x , ' ' , y , ', default;'
      , '}'
      , '.cursor_' , cursor_id , '_important { '
      ,   'cursor: url(' , canvas.toDataURL() , ') ' , x , ' ' , y , ', default !important;'
      , '}'
      , '.cursor_' , cursor_id , '_important:active { '
      ,   'cursor: url(' , canvas.toDataURL() , ') ' , x , ' ' , y , ', default !important;'
      , '}'
    ].join('') + '\n';
    setTimeout(function () {
      callback();
    }, 20);
  }

  XServerClient.prototype.QueryBestSize = function (req, callback) {
    console.log('QueryBestSize');
    var _class = req.data_byte
      , drawable = this.server.getResource(req.data.readUInt32(0), x_types.Drawable)
      , width = req.data.readUInt16(4)
      , height = req.data.readUInt16(6);
    var rep = new x_types.Reply(req);
    switch (_class) {
      case 0: // Cursor
        rep.data.writeUInt16(64, 0); // Cursors are always 64x64
        rep.data.writeUInt16(64, 2);
      break;
      default:
        throw new Error('Class not implemented');
    }
    callback(null, rep);
  }

  XServerClient.prototype.QueryExtension = function (req, callback) {
    console.log('QueryExtension - Incomplete');
    var rep = new x_types.Reply(req);
    rep.data.writeUInt8(0, 0);
    rep.data.writeUInt8(req.opcode, 1);
    rep.data.writeUInt8(0, 2);
    rep.data.writeUInt8(0, 3);
    callback(null, rep);
  }

  XServerClient.prototype.ListExtensions = function (req, callback) {
    console.log('ListExtensions');
    var rep = new x_types.Reply(req);
    callback(null, rep);
  }

  XServerClient.prototype.GetKeyboardMapping = function (req, callback) {
    var self = this
      , first = req.data.readUInt8(0)
      , count = req.data.readUInt8(1)
      , rep = new x_types.Reply(req);

    rep.data_byte = self.server.keymap.maxModifiers;

    for (var key = first; key < first + count; key++) {
      var keyObj = self.server.keymap.get(key);
      for (var mod = 0; mod < rep.data_byte; mod ++) {
        if (keyObj) {
          var modifier = ~~Math.pow(2, mod - 1)
            , keycode = keyObj['' + ~~Math.pow(2, mod - 1)] || keyObj['0'];
          rep.data_extra.push(new x_types.UInt32(self.server.keymap.getKeysym(keycode, modifier & 1)));
        } else
          rep.data_extra.push(new x_types.UInt32(0));
      }
    }
    callback(null, rep);
  }

  XServerClient.prototype.Bell = function (req, callback) {
    var percent = req.data_byte;
    $('audio#bell')[0].play();
    callback();
  }

  var _closedown_mode = ['destroy', 'permanent', 'temporary'];
  XServerClient.prototype.SetCloseDownMode = function (req, callback) {
    this.closedown = _closedown_mode[req.data_byte];
    callback();
  }
  
  XServerClient.prototype.KillClient = function (req, callback) {
    var rid = req.data.readUInt32(0)
      , resource = this.server.resources[rid];
    console.log('KillClient', rid, resource);
    if (rid && resource)
      resource.owner.disconnect();
    console.warn('TODO', 'Finish me');
    callback();
  }

  XServerClient.prototype.GetModifierMapping = function (req, callback) {
    var self = this
      , rep = new x_types.Reply(req)
      , datas = (['Shift', 'Lock', 'Control', 'Mod1', 'Mod2', 'Mod3', 'Mod4', 'Mod5']).map(function (name) { return self.server.keymap.find(name) });

    rep.data_byte = datas.reduce(function (o, v) { return Math.max(o, v.length) }, 0);
    rep.data_extra = datas.reduce(function (array, values) { for (var i = 0; i < rep.data_byte; i++) { array.push(new x_types.UInt8(values [i] || 0)) }; return array }, []);
    callback(null, rep);
  }

  XServerClient.prototype.NoOperation = function (req, callback) {
    callback();
  }

  function stringPad (string) {
    return string.length + (4 - ((string.length % 4) || 4));
  }

  return XServerClient;
});
