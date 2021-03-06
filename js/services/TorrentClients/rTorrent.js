/**
 * rTorrent
 *
 * API Docs:
 * https://github.com/rakshasa/rtorrent/wiki/RPC-Setup-XMLRPC
 * https://github.com/rakshasa/rtorrent/wiki/rTorrent-0.9-Comprehensive-Command-list-(WIP)
 */
rTorrentData = function(data) {
    this.update(data);
};

PromiseFileReader = function() {

    this.readAsDataURL = function(blob) {
        return new Promise(function(resolve, reject) {
            var reader = new FileReader();
            reader.onload = function(e) {
                resolve(e.target.result);
            };
            reader.onerror = function(e) {
                reject(e);
            };
            reader.readAsDataURL(blob);
        });
    };

    return this;
};

rTorrentData.extends(TorrentData, {
    getName: function() {
        return this.name;
    },
    getProgress: function() {
       return this.round(this.bytes_done / this.size_bytes  * 100, 1);
    },
    getDownloadSpeed: function() {
        return this.down_rate; // Bytes/second
    },
    start: function() {
        this.getClient().getAPI().execute('d.start', this.hash);
    },
    stop: function() {
        this.getClient().getAPI().execute('d.stop', this.hash);
    },
    pause: function() {
        this.getClient().getAPI().execute('d.pause', this.hash);
    },
    remove: function() {
        this.getClient().getAPI().execute('d.erase', this.hash);
    },
    isStarted: function() {
        return this.state > 0;
    },
    /**
     * Impossible without parsing the .torrent???
     */
    getFiles: function() {
        var self = this;
        return new Promise(function(resolve) {
            resolve([{name: self.base_filename}]);
        });
    },
    getDownloadDir: function() {
        return this.directory_base;
    }
});

DuckieTorrent.factory('rTorrentRemote', ["BaseTorrentRemote",
    function(BaseTorrentRemote) {

        var rTorrentRemote = function() {
            BaseTorrentRemote.call(this);
            this.dataClass = rTorrentData;
        };
        rTorrentRemote.extends(BaseTorrentRemote);

        return rTorrentRemote;
    }
])

.factory('rTorrentAPI', ['BaseHTTPApi', 'xmlrpc', '$q',
    function(BaseHTTPApi, xmlrpc, $q) {

        var rTorrentAPI = function() {
            BaseHTTPApi.call(this);
        };
        rTorrentAPI.extends(BaseHTTPApi, {

            
            rpc: function(method, params, options) {
                
                  xmlrpc.config({
                    hostName: this.config.server+':'+this.config.port, // Default is empty
                    pathName: this.config.path, // Default is /rpc2
                    401: function() {
                        console.warn("You shall not pass !");
                    },
                    404: function() {
                        console.info("API not found");
                    },
                    500: function() {
                        console.error("Something went wrong :(");
                    }
                });
                 
                return xmlrpc.callMethod(method, params).then(function(result) {
                    return result;

                });
                
            },
            portscan: function() {
                return this.rpc('system.api_version').then(function(result) {
                    return result !== undefined;
                }, function() {
                    return false;
                });
            },
            getTorrents: function() {
                var self = this;
                return this.rpc('download_list').then(function(data) {
                    var args = [];
                    var indexMap = {};
                    var props = ["d.get_base_filename", "d.get_base_path", "d.get_bytes_done", "d.get_completed_bytes","d.get_directory", "d.get_directory_base", "d.get_down_rate", "d.get_down_total", "d.get_hash", "d.get_name", "d.get_size_bytes", "d.get_state", "d.get_up_rate"];

                    data.map(function(hash) {
                        indexMap[hash] = {};
                        props.map(function(prop) {
                            propTransformer(prop, hash)
                        });
                    })

                    function propTransformer(prop, hash) {
                        var idx = args.push({ "methodName" : prop, "params": [hash]});
                        indexMap[hash][prop] = idx -1;
                    }

                    return self.rpc('system.multicall', [args]).then(function(result) {
                        var output = [];
                        Object.keys(indexMap).map(function(hash) {
                            var torrent = { hash: hash};
                            Object.keys(indexMap[hash]).map(function(property) {
                                torrent[property.replace('d.get_','')] = result[indexMap[hash][property]][0];
                            })
                            output.push(torrent);
                        })
                        return output;
                    })




    /* 

    {"key":"hash","rt":"d.get_hash="},
    {"key":"state","rt":"d.get_state="},
    {"key":"name","rt":"d.get_name="},
    {"key":"size_bytes","rt":"d.get_size_bytes="},
    {"key":"up_total","rt":"d.get_up_total="},
    {"key":"ratio","rt":"d.get_ratio="},
    {"key":"up_rate","rt":"d.get_up_rate="},
    {"key":"down_rate","rt":"d.get_down_rate="},
    {"key":"peers","rt":"d.get_peers_accounted="},
    {"key":"base_path","rt":"d.get_base_path="},
    {"key":"date","rt":"d.get_creation_date="},
    {"key":"active","rt":"d.is_active="},
    {"key":"complete","rt":"d.complete="},
    {"key":"downsize","rt":"d.get_down_total="},
    {"key":"directory","rt":"d.get_directory="},
    {"key":"skipsize","rt":"d.get_skip_total="}

    */

                    return data.arguments.torrents.map(function(el) {
                        
                        el.hash = el.hashString.toUpperCase();
                        return el;
                    });
                });
            },
            addMagnet: function(magnetHash) {
                return this.rpc('load_start', [magnetHash]);
            },
            addTorrentByUrl: function(url, releaseName) {
                return this.addMagnet(url).then(function(result) {
                         
                    var currentTry = 0;
                    var maxTries = 5;
                    // wait for rTorrent to add the torrent to the list. we poll 5 times until we find it, otherwise abort.
                    return $q(function(resolve, reject) {
                        /*
                         * find the most likely torrent candidate in the uTorrent host,
                         * based on the .torrent releaseName we just uploaded via the uTorrent WebUi client
                         */
                        function verifyAdded() {
                            // helper function that counts how many words in source are in target
                            function getScore(source, target) {
                                var score = 0;
                                // strip source of non alphabetic characters and duplicate words
                                var sourceArray = source
                                .toUpperCase()
                                .replace(/[^A-Z0-9]+/g, ' ')
                                .trim()
                                .split(' ')
                                .filter(function(item, i, allItems) {
                                    return i == allItems.indexOf(item);
                                });
                                // strip target of non alphabetic characters and duplicate words
                                var targetString = target
                                .toUpperCase()
                                .replace(/[^A-Z0-9]+/g, ' ')
                                .trim()
                                .split(' ')
                                .filter(function(item, i, allItems) {
                                    return i == allItems.indexOf(item)
                                })
                                .join(' ');
                                // count how many words of source are in target
                                sourceArray.map(function(sourceWord) {
                                    if (targetString.indexOf(sourceWord) > -1) {
                                        score++;
                                    }
                                });
                                return score;
                            }

                            currentTry++;
                            self.getTorrents().then(function(result) {
                                var hash = null;
                                var bestScore = 0;
                                // for each torrent compare the torrent.name with .torrent releaseName and record the number of matching words
                                result.map(function(torrent) {
                                    var score = getScore(releaseName, torrent.name);
                                    if (score > bestScore) {
                                        hash = torrent.hash.toUpperCase();
                                        bestScore = score;
                                    }
                                });
                                if (hash !== null) {
                                    resolve(hash);
                                } else {
                                    if (currentTry < maxTries) {
                                        setTimeout(verifyAdded, 1000);
                                    } else {
                                        throw "No hash found for torrent " + releaseName + " in 5 tries.";
                                    }
                                }
                            });
                        }
                        setTimeout(verifyAdded, 1000);
                    });
                });
            },
            addTorrentByUpload: function(data, releaseName) {
                var self = this;
                return new PromiseFileReader().readAsDataURL(data).then(function(contents) {
                    var key = "base64,",
                        index = contents.indexOf(key);
                    if (index > -1) {
                         var value = new base64_xmlrpc_value(contents.substring(index + key.length));
                        return self.rpc('load_raw_start', [value]).then(function(result) {
                         
                            var currentTry = 0;
                            var maxTries = 5;
                            // wait for rTorrent to add the torrent to the list. we poll 5 times until we find it, otherwise abort.
                            return $q(function(resolve, reject) {
                                /*
                                 * find the most likely torrent candidate in the uTorrent host,
                                 * based on the .torrent releaseName we just uploaded via the uTorrent WebUi client
                                 */
                                function verifyAdded() {
                                    // helper function that counts how many words in source are in target
                                    function getScore(source, target) {
                                        var score = 0;
                                        // strip source of non alphabetic characters and duplicate words
                                        var sourceArray = source
                                        .toUpperCase()
                                        .replace(/[^A-Z0-9]+/g, ' ')
                                        .trim()
                                        .split(' ')
                                        .filter(function(item, i, allItems) {
                                            return i == allItems.indexOf(item);
                                        });
                                        // strip target of non alphabetic characters and duplicate words
                                        var targetString = target
                                        .toUpperCase()
                                        .replace(/[^A-Z0-9]+/g, ' ')
                                        .trim()
                                        .split(' ')
                                        .filter(function(item, i, allItems) {
                                            return i == allItems.indexOf(item)
                                        })
                                        .join(' ');
                                        // count how many words of source are in target
                                        sourceArray.map(function(sourceWord) {
                                            if (targetString.indexOf(sourceWord) > -1) {
                                                score++;
                                            }
                                        });
                                        return score;
                                    }

                                    currentTry++;
                                    self.getTorrents().then(function(result) {
                                        var hash = null;
                                        var bestScore = 0;
                                        // for each torrent compare the torrent.name with .torrent releaseName and record the number of matching words
                                        result.map(function(torrent) {
                                            var score = getScore(releaseName, torrent.name);
                                            if (score > bestScore) {
                                                hash = torrent.hash.toUpperCase();
                                                bestScore = score;
                                            }
                                        });
                                        if (hash !== null) {
                                            resolve(hash);
                                        } else {
                                            if (currentTry < maxTries) {
                                                setTimeout(verifyAdded, 1000);
                                            } else {
                                                throw "No hash found for torrent " + releaseName + " in " + maxTries + " tries.";
                                            }
                                        }
                                    });
                                }
                                setTimeout(verifyAdded, 1000);
                            });
                        })
                    }
                });
            },
            execute: function(method, id) {
                return this.rpc(method, [id]);
            }
        });

        return rTorrentAPI;
    }
])

.factory('rTorrent', ["BaseTorrentClient", "rTorrentRemote", "rTorrentAPI",
    function(BaseTorrentClient, rTorrentRemote, rTorrentAPI) {

        var rTorrent = function() {
            BaseTorrentClient.call(this);
        };
        rTorrent.extends(BaseTorrentClient, {});

        var service = new rTorrent();
        service.setName('rTorrent');
        service.setAPI(new rTorrentAPI());
        service.setRemote(new rTorrentRemote());
        service.setConfigMappings({
            server: 'rtorrent.server',
            port: 'rtorrent.port',
            path: 'rtorrent.path'
        });
        service.readConfig();

        return service;
    }
])

.run(["DuckieTorrent", "rTorrent", "SettingsService",
    function(DuckieTorrent, rTorrent, SettingsService) {
        if (SettingsService.get('torrenting.enabled')) {
            DuckieTorrent.register('rTorrent', rTorrent);
        }
    }
]);