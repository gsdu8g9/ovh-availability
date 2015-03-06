var async        = require('async');
var crypto       = require('crypto');
var countries    = require('country-data').countries;
var phone        = require('phone');
var data         = require('./data');
var ovh          = require('./ovhApi');
var recaptcha    = require('./recaptcha');
var newrelic     = require('./newrelicApi');
var serversModel = require('../models/servers');
var requestModel = require('../models/requests');

/*
 *  INDEX
 *  Route : /
 *  Methode : GET
 */
exports.index = function( req, res, next ) {

    data.settings(req, res, { shouldBeLogged:false, mayBeLogged:true }, function( settings ) {
        loadResources({ refs:false }, next, function( ressources ) {

            settings.formErrors     = {};
            settings.sysServersList = ressources.sysServersList;
            settings.kimServersList = ressources.kimServersList;
            settings.stats          = ressources.stats;
            settings.countries      = countries.all;
            settings.pushbullet     = ( req.session.pushbullet.token ) ? true : false;
            settings.values         = {
                mail: ( settings.pushbullet ) ? req.session.pushbullet.email : null
            };

            res.render('index', settings);

        });
    });

};

/*
 *  INDEX
 *  Route : /
 *  Methode : POST
 */
exports.run = function( req, res, next ) {

    data.settings(req, res, { shouldBeLogged:false, mayBeLogged:true }, function( settings ) {
        loadResources({ refs:true }, next, function( ressources ) {

            var invalid  = 'La valeur de ce champ est invalide.';
            var required = 'Ce champ est requis.';

            // Validation des valeurs contenues dans req.body
            req.checkBody('mail', invalid).isEmail().len(5, 100);
            req.checkBody('mail', required).notEmpty();
            req.checkBody('zone', invalid).isIn(['europe', 'canada', 'all']);
            req.checkBody('zone', required).notEmpty();
            req.checkBody('server', invalid).isIn( ressources.refsList );
            req.checkBody('server', required).notEmpty();

            if( req.body.phone )
                req.checkBody('country', required).notEmpty();

            if( req.body.country )
                req.checkBody('phone', required).notEmpty();

            var errors = req.validationErrors( true );

            async.waterfall([

                // Vérification du formulaire
                function( callback ) {

                    if( errors )
                        callback("Une erreur est survenue lors de la validation du formulaire, veuillez vérifier les données saisies.");
                    else
                        callback();

                },

                // Validation du numéro de téléphone
                function( callback ) {

                    if( req.body.phone ) {

                        var phoneNumber = phone( req.body.phone, req.body.country )[0];

                        if( ! phoneNumber ) {

                            callback("Votre numéro de téléphone est invalide.");

                        } else {

                            // Numéro de téléphone mobile au format international
                            // Norme : UIT-T E.164 (11/2010)
                            // Préfixe international + indicatif pays + numéro national significatif
                            // Exemple (france) : 003361601XXXX
                            req.session.phone = "00" + String( phoneNumber ).substring(1);
                            callback();

                        }

                    } else {

                        callback();

                    }

                },

                // Vérification du captcha
                function( callback ) {

                    recaptcha.verify(req, req.body["g-recaptcha-response"], next, function( result ) {

                        if( ! result )
                            callback("Veuillez cocher la case située à la fin du formulaire afin de prouver que vous êtes bien humain.");
                        else
                            callback();

                    });

                },

                // Vérification de l'unicité de la demande
                function( callback ) {

                    requestModel.unique({ ref:(req.body.server).toLowerCase(), mail:(req.body.mail).toLowerCase() }, next, function( unique ) {

                        if( ! unique )
                            callback("Votre demande est toujours en attente, vous ne pouvez pas en créer plusieurs à la fois. Merci d'attendre de recevoir la notification par mail / Pushbullet.");
                        else
                            callback();

                    });

                },

                // Vérification de la disponibilité de l'offre
                function( callback ) {

                    ovh.getJson(next, function( json ) {
                        ovh.checkOffer(json, req.body.server, req.body.zone, next, function( available ) {

                            if( available )
                                callback("Cette offre est déjà disponible, vous pouvez réserver votre serveur dès à présent.");
                            else
                                callback();

                        });
                    });

                },

                // Ajout de la demande au sein de la base de données
                function( callback ) {

                    crypto.randomBytes(24, function( ex, buffer ) {

                        var data = {
                            reference:req.body.server,
                            mail:req.body.mail,
                            token:buffer.toString('hex'),
                            phone: ( req.session.phone ) ? req.session.phone : null,
                            pushbulletToken: ( req.session.pushbullet.token ) ? req.session.pushbullet.token : null,
                            zone:req.body.zone
                        };

                        requestModel.add(data, next, function( result ) {

                            if( req.session.phone ) delete req.session.phone;

                            if( result ) {

                                callback();

                            } else {

                                next( new Error("Une erreur est survenue lors de l'enregistrement de votre demande dans la base de données.") );
                                return;

                            }

                        });
                    });

                }

            ], function( err, result ) {

                if( err ) {

                    settings.formError   = true;
                    settings.formMessage = err;

                } else {

                    var events = [];
                    var eventObject = {
                        "eventType":"availabilityRequest",
                        "reference":req.body.server,
                        "zone":req.body.zone
                    };

                    events.push( eventObject );
                    newrelic.submitEvents( events );

                    settings.formSuccess = true;
                    settings.formMessage = 'Votre demande a bien été prise en compte.';

                }

                settings.formErrors     = ( errors ) ? errors : {};
                settings.sysServersList = ressources.sysServersList;
                settings.kimServersList = ressources.kimServersList;
                settings.stats          = ressources.stats;
                settings.countries      = countries.all;
                settings.pushbullet     = ( req.session.pushbullet.token ) ? true : false;
                settings.values         = req.body;

                res.render('index', settings);

            });

        });

    });

};

/*
 *  INDEX
 *  Route : /request/reactivate/:token
 *  Methode : GET
 */
exports.reactivate = function( req, res, next ) {

    data.settings(req, res, { shouldBeLogged:false, mayBeLogged:true }, function( settings ) {
        requestModel.getRequestByToken(req.params.token, next, function( request ) {

            async.waterfall([

                // Vérification du token
                function( callback ) {

                    if( ! request )
                        callback("Impossible d'effectuer cette action, token invalide.");
                    else
                        callback();

                },

                // Vérification de l'état de la demande
                function( callback ) {

                    if( request.state == 'pending' )
                        callback("Impossible d'effectuer cette action, votre demande est toujours active.");
                    else
                        callback();

                },

                // Mise à jour de la demande
                function( callback ) {

                    crypto.randomBytes(24, function( ex, buffer ) {

                        var token = buffer.toString('hex');

                        requestModel.updateState('pending', request.id, next);
                        requestModel.updateToken(token, request.id, next);

                        callback();

                    });

                }

            ], function( err, result ) {

                if( err ) {

                    next( new Error( err ) );
                    return;

                } else {

                    var events = [];
                    var eventObject = {
                        "eventType":"reactivateRequest",
                        "count":1
                    };

                    events.push( eventObject );
                    newrelic.submitEvents( events );

                    settings.formSuccess = true;
                    settings.formMessage = 'Votre demande a bien été réactivée.';
                    settings.request     = request;

                }

                res.render('reactivate', settings);

            });

        });
    });
};

/*
 *  Charge toutes les ressources de manière asynchrone
 */
var loadResources = function( options, next, callback ) {

    async.parallel({

        // Liste des serveurs Kimsufi
        sysServersList: function( callback ) {
            serversModel.getServers('sys', next, function( sysServersList ) {
                callback(null, sysServersList);
            });
        },

        // Liste des serveurs SoYouStart
        kimServersList: function( callback ) {
            serversModel.getServers('kimsufi', next, function( kimServersList ) {
                callback(null, kimServersList);
            });
        },

        // Liste des références OVH
        refsList: function( callback ) {

            if( options.refs ) {

                serversModel.getAllRefs(next, function( refsList ) {
                    callback(null, refsList);
                });

            } else {

                callback();

            }

        },

        // Statistiques
        stats: function( callback ) {
            requestModel.getStatistics(next, function( stats ) {
                callback(null, stats);
            });
        }

    }, function( err, resources ) {

        if( err ) {

            next( new Error( err ) );
            return;

        }

        callback( resources );

    });

};
